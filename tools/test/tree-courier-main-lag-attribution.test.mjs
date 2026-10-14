/* W22 agent-run-lag. main-lag.log's blocker column reads "unattributed" for
 * 268 of 280 recorded stalls (Manager 3, 2026-09-04) because the tree
 * courier's own work -- a setInterval, not an ipcMain handler -- was never
 * wrapped in shell/main-lag.cjs's note()/span() door. This test asserts the
 * BEHAVIOUR the wrapping exists to produce: given a real createMainLagMonitor
 * wired in as `mainLag`, driving one courier round against a session on the
 * tree leaves the monitor's worst-span attributed to a named tree-courier
 * source, not left null the way an unwrapped round would leave it. It calls
 * the real createAgentHost with the same confined-engine fixture the rest of
 * the host suite already uses, and asserts on the monitor's own stats(),
 * never on a specific millisecond figure -- the claim is "named", not "slow".
 */
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
const { createMainLagMonitor, UNATTRIBUTED } = require_(path.join(ROOT, 'shell/main-lag.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-tree-courier-mainlag-test')
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
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return null
}

test('a courier round with mainLag wired in attributes its worst span to a named tree-courier source, not "unattributed"', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'attrib-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const logFile = path.join(workdir, 'main-lag.log')
  const monitor = createMainLagMonitor({ file: logFile })
  const sessionId = 'manager-session'

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    // Fast enough to drive in seconds; still a positive integer courier clock
    // as treeCourierTimingOf requires, same seam every other host test uses.
    treeCourier: { pollMs: 50, heartbeatMs: 50, readDeadlineMs: 200 },
    mainLag: monitor,
  })

  try {
    await host.startSession({ sessionId })
    await host.sendTurn({ sessionId, text: BRIEF, origin: 'brief' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    // Registration lands on the poll tick too (see tree-register-retry.test.mjs);
    // wait for the node to actually join before asking whether a round ran.
    const joined = await waitFor(() => directory.listNodes().length === 1, 4_000)
    assert.ok(joined, 'the session never joined the tree, so no courier round had anything to pump')

    // The courier round that registers the node already pumps it once it is
    // on the tree; wait for at least one heartbeat, which only happens inside
    // pumpTreeSession -- proof a round actually executed past planning.
    const beat = await waitFor(() => directory.heartbeatCount(sessionId) > 0, 4_000)
    assert.ok(beat, 'no courier round ever reached pumpTreeSession for the registered circle')

    const stats = monitor.stats()
    assert.notEqual(stats.worstLabel, null, 'the monitor recorded no span at all for a round that provably ran')
    assert.notEqual(stats.worstLabel, UNATTRIBUTED, 'the courier round\'s own work must not fall back to "unattributed"')
    /* Not pinned to the 'tree-courier:' prefix alone. A courier round's own
       synchronous work is attributed under three families depending on which
       part actually ran longest that tick: 'tree-courier:' for the in-memory
       plan/read-dispatch steps, 'tree-lock:wait:' for a contended mutation
       lock, 'tree-directory:' for the mutation's own fs read/write/fsync
       (agent-host.cjs's loadTreeMessaging injects lockSleep/fsImpl so each of
       those can be timed on its own). Which one wins is the real,
       unpredictable answer this instrument exists to produce -- fsync
       genuinely outranking an in-memory plan step is a correct result, not a
       bug, and pinning to one spelling would fail the moment it does. */
    const COURIER_ATTRIBUTION_PREFIXES = ['tree-courier:', 'tree-lock:wait:', 'tree-directory:']
    assert.ok(COURIER_ATTRIBUTION_PREFIXES.some(prefix => stats.worstLabel.startsWith(prefix)),
      `the attributed span must belong to the courier round's own work (one of ${JSON.stringify(COURIER_ATTRIBUTION_PREFIXES)}), got ${JSON.stringify(stats.worstLabel)}`)
    assert.ok(stats.worstMs >= 0, 'a recorded span must carry a non-negative duration')
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the heartbeat mutation call is attributed at its own call site, isolated from the rest of the per-circle pass (Manager 3, M7)', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'heartbeat-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const sessionId = 'manager-session-heartbeat'
  const seenLabels = []
  const spyingMonitor = createMainLagMonitor({ file: path.join(workdir, 'main-lag.log') })
  const monitor = {
    note: (label, fn) => { seenLabels.push(label); return spyingMonitor.note(label, fn) },
    span: (label) => { seenLabels.push(label); return spyingMonitor.span(label) },
    /* Lock-wait time is reported through recordDuration(), not note()/span()
       (see the note beside remember() in shell/main-lag.cjs) -- a spy that
       only wraps note/span never sees it, and a mainLag object with no
       recordDuration property at all makes agent-host.cjs's loadTreeMessaging
       fall back to a no-op, silently dropping the measurement. */
    recordDuration: (label, ms) => { seenLabels.push(label); return spyingMonitor.recordDuration(label, ms) },
  }

  /* The fixture's lockSleep hook is a no-op by default (real contention is
     rare in a single-writer test run), so the lock-wait recordDuration this
     test is asserting on never fires unless something makes the retry loop
     spin. setSimulatedLockRetries exists on the fixture specifically for
     this: "so tools/test/tree-courier-main-lag-attribution.test.mjs can
     prove agent-host.cjs's injected lockSleep/fsImpl are really invoked and
     really timed" (fixture's own comment). */
  directory.setSimulatedLockRetries(3)

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    treeCourier: { pollMs: 50, heartbeatMs: 50, readDeadlineMs: 200 },
    mainLag: monitor,
  })

  try {
    await host.startSession({ sessionId })
    await host.sendTurn({ sessionId, text: BRIEF, origin: 'brief' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    const beat = await waitFor(() => directory.heartbeatCount(sessionId) > 0, 4_000)
    assert.ok(beat, 'no courier round ever reached the heartbeat mutation call')

    /* 'tree-lock:wait:heartbeat:<sessionLabel>', not 'tree-courier:heartbeat-mutate:':
       agent-host.cjs's loadTreeMessaging() moved from wrapping the whole
       heartbeatNode() call in one span to injecting lockSleep/fsImpl and
       reporting the lock-wait delta on its own (see the W22 ATTRIBUTION MARK
       comment beside heartbeatNode's call site) -- a finer-grained
       replacement for the mechanism this test names, not a different one. */
    assert.ok(seenLabels.some(label => label.startsWith('tree-lock:wait:heartbeat:')),
      `the heartbeat mutation's lock-wait was never attributed at its own call site; saw ${JSON.stringify(seenLabels)}`)
    /* NOT wrapped in a round-wide pump-session span: main-lag.cjs's remember()
       keeps only the single worst span since the last tick, so a coarser span
       containing this one would always be at least as long and would always
       win the comparison, hiding this exact number -- the mistake corrected
       in this same edit (see the note beside its removal in agent-host.cjs). */
    assert.ok(!seenLabels.some(label => label.startsWith('tree-courier:pump-session:')),
      'a coarser wrap around the whole per-circle pass has returned, which would mask this span again')
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the same round with no mainLag wired in never touches a bystander monitor (the wiring, not something else, produces the attribution)', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'no-wire-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const bystander = createMainLagMonitor({ file: path.join(workdir, 'bystander.log') })
  const sessionId = 'manager-session-2'

  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    treeCourier: { pollMs: 50, heartbeatMs: 50, readDeadlineMs: 200 },
    // mainLag intentionally omitted -- the default-absent path.
  })

  try {
    await host.startSession({ sessionId })
    await host.sendTurn({ sessionId, text: BRIEF, origin: 'brief' })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    const beat = await waitFor(() => directory.heartbeatCount(sessionId) > 0, 4_000)
    assert.ok(beat, 'no courier round ever reached pumpTreeSession for the registered circle')

    assert.deepEqual(bystander.stats().worstLabel, null,
      'a monitor never handed to createAgentHost must stay untouched by the courier round')
  } finally {
    await host.closeAll().catch(() => {})
    require_(DIRECTORY).reset()
    require_(PROVIDER).reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
