/* THE APPLICATION HALF OF "MY MANAGER IS GONE, AND I AM STILL WORKING".
 *
 * Ledger T123, measured 2026-09-15: a manager's session failed every turn from
 * 21:47Z; each worker below it finished one item, sent the report to a circle
 * that could no longer read it, and then sat idle for over three hours. The
 * engine's continuation controller was always going to send those workers their
 * own next turn -- what nothing could tell it was that the manager had stopped,
 * so the turn it sent never said so and no ancestor was ever told.
 *
 * Only the main process knows which running session is which circle on the
 * person's tree, so the observation has to live in shell/agent-host.cjs. This
 * suite proves the rule by CALLING IT WITH VALUES and proves the wiring by
 * driving the real host: no test below asserts that a particular sentence,
 * field name or code path was spelled a particular way, because a spelling pin
 * fails against a better implementation and the quickest way back to green is
 * to put the defect back.
 *
 * Run: node --test tools/test/agent-manager-outage-continuation.test.mjs
 */

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
/* The same fixture payload with a provider that can die on its own; see the
   note at the top of that file for why it is not the shared one. */
const EXITING_ENGINE = path.join(FIXTURE_ROOT, 'src/lib/agent-engine/exiting-codex-process.js')
const host_ = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const {
  MANAGER_NOTICE_TASK_IDS_MAX,
  MANAGER_REPORT_SILENCE_MS,
  MANAGER_TURN_FAILURE_STREAK,
  createAgentHost,
  createManagerEpisodes,
  managerCoordinationNotice,
  managerNodeIdOf,
  managerOutageFact,
} = host_

/* See the note in agent-local-message-host-seam.test.mjs: left unset,
   createAgentHost reads the real os.freemem() and every start below would
   refuse whenever this computer happens to be short of memory, so the suite's
   colour would track the machine rather than the code under test. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024
const SCRATCH = testScratchRoot('.toolsenabled-manager-outage-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

/* One tree: Controller -> Manager -> Worker. Root-first ancestry ending on the
   node's own key, the shape adoptTreeAddress() enforces. */
const CONTROLLER = 'node-controller'
const MANAGER = 'node-manager'
const WORKER = 'node-worker'
const ANCHORS = [CONTROLLER, MANAGER, WORKER]

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

function row(nodeId, extra = {}) {
  return { nodeId, sessionId: `${nodeId}-session`, name: nodeId, live: true, consecutiveTurnFailures: 0, ...extra }
}

/* ------------------------------------------------------------------ *
 * THE RULE, CALLED WITH VALUES.
 * ------------------------------------------------------------------ */

test('a manager that is running and simply has nothing to say is not an outage', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER), row(MANAGER), row(WORKER)],
    report: null,
  })
  assert.equal(fact, null,
    'an idle but healthy manager was reported as an outage; a worker would abandon a manager about to answer it')
})

test('a manager this process never saw is unknown, not dead', () => {
  /* The manager's node is simply not among the circles the caller can speak
     about. "Could not look" and "is not there" are different answers and this
     is the first one. */
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER), row(WORKER)],
    report: null,
  })
  assert.equal(fact, null, 'an unobserved manager was claimed as an outage')
})

test('a manager whose session ended is an outage, and it names the circle above the gap', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    managerName: 'Manager 6',
    nodes: [row(CONTROLLER, { name: 'Controller' }), row(MANAGER, { name: 'Manager 6', live: false }), row(WORKER)],
    report: null,
  })
  assert.ok(fact, 'a manager observed to have stopped produced no outage fact')
  assert.equal(fact.managerNodeId, MANAGER)
  assert.equal(fact.reason, 'session-unavailable')
  assert.equal(fact.managerName, 'Manager 6')
  assert.equal(fact.ancestor?.nodeId, CONTROLLER,
    'the escalation was not addressed to the nearest live circle above the manager')
})

test('the escalation walks up past a dead grandparent to the first live ancestor', () => {
  const GREAT = 'node-owner'
  const fact = managerOutageFact({
    anchors: [GREAT, CONTROLLER, MANAGER, WORKER],
    selfNodeId: WORKER,
    nodes: [row(GREAT), row(CONTROLLER, { live: false }), row(MANAGER, { live: false }), row(WORKER)],
  })
  assert.equal(fact?.ancestor?.nodeId, GREAT,
    'the notice was addressed to a circle that is also gone, which is the same silence this exists to end')
})

test('with every ancestor gone the outage is still reported, with no ancestor to send to', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER, { live: false }), row(MANAGER, { live: false }), row(WORKER)],
  })
  assert.ok(fact, 'the outage vanished because nobody was left to tell')
  assert.equal(fact.ancestor, null)
})

test('the top of a tree has no manager to lose', () => {
  assert.equal(managerNodeIdOf([CONTROLLER], CONTROLLER), null)
  assert.equal(managerOutageFact({ anchors: [CONTROLLER], selfNodeId: CONTROLLER, nodes: [] }), null)
})

test('one failed turn is a hiccup; the configured streak is a failing manager', () => {
  const nodes = failures => [row(CONTROLLER), row(MANAGER, { consecutiveTurnFailures: failures }), row(WORKER)]
  const below = managerOutageFact({ anchors: ANCHORS, selfNodeId: WORKER, nodes: nodes(MANAGER_TURN_FAILURE_STREAK - 1) })
  assert.equal(below, null, 'a single failed turn was enough to call a manager dead')
  const at = managerOutageFact({ anchors: ANCHORS, selfNodeId: WORKER, nodes: nodes(MANAGER_TURN_FAILURE_STREAK) })
  assert.equal(at?.reason, 'turn-failed')
})

test('report silence is judged from real timing, and an answer ends it', () => {
  const now = 1_800_000_000_000
  const sentAt = now - MANAGER_REPORT_SILENCE_MS - 1
  const nodes = [row(CONTROLLER), row(MANAGER), row(WORKER)]
  const call = report => managerOutageFact({ anchors: ANCHORS, selfNodeId: WORKER, nodes, report, now })

  assert.equal(call({ sentAt, answeredAt: null })?.reason, 'report-unanswered')
  assert.equal(call({ sentAt, answeredAt: sentAt + 1 }), null,
    'a report that WAS answered still counted as silence')
  assert.equal(call({ sentAt: now - 1000, answeredAt: null }), null,
    'ordinary latency was reported as an outage')
  assert.equal(call(null), null,
    'a caller with no report timing at all produced a claim it cannot evidence')
})

test('a circle that cannot take a turn outranks one whose turns merely fail', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER), row(MANAGER, { live: false, consecutiveTurnFailures: 9 }), row(WORKER)],
  })
  assert.equal(fact?.reason, 'session-unavailable')
})

/* ------------------------------------------------------------------ *
 * ONE OUTAGE IS ONE EPISODE.
 * ------------------------------------------------------------------ */

test('an episode id holds still while the outage lasts and changes after a recovery', () => {
  const episodes = createManagerEpisodes()
  const first = episodes.idFor(MANAGER, 'session-a', 'session-unavailable')
  assert.equal(episodes.idFor(MANAGER, 'session-a', 'session-unavailable'), first,
    'the same continuing outage produced a second episode, so the ancestor would be told again every tick')

  assert.equal(episodes.recovered(MANAGER), true)
  const afterRecovery = episodes.idFor(MANAGER, 'session-a', 'session-unavailable')
  assert.notEqual(afterRecovery, first,
    'a later, separate outage reused the answered episode, so nobody would be told about it at all')

  assert.notEqual(episodes.idFor(MANAGER, 'session-b', 'session-unavailable'), afterRecovery,
    'a replacement manager session was folded into its predecessor\'s episode')
  assert.equal(episodes.recovered('node-never-down'), false,
    'a circle that never went down was recorded as having recovered')
})

/* ------------------------------------------------------------------ *
 * WHAT THE CIRCLE ABOVE THE GAP IS TOLD.
 * ------------------------------------------------------------------ */

test('the notice says who is stuck, which manager broke, and that nothing was reassigned', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER), row(MANAGER, { name: 'Manager 6', live: false }), row(WORKER)],
  })
  const text = managerCoordinationNotice({ fact, taskIds: ['T123', 'T124'], selfName: 'Worker 64' })
  assert.ok(text, 'an outage produced no sentence for the person above it')
  assert.ok(text.includes('Worker 64'), 'the notice does not say which agent is stuck')
  assert.ok(text.includes('Manager 6'), 'the notice does not say which manager broke')
  assert.ok(text.includes('T123') && text.includes('T124'),
    'the notice does not say the worker kept working, which is the whole claim')
  assert.ok(/reassign/i.test(text) && /stop/i.test(text),
    'the notice does not say that nothing was reassigned or stopped, and that is the first thing a reader reaches for')
  assert.ok(!/[\\/]|node_modules/.test(text), 'the notice carries a path')
})

test('the named task ids are capped and the notice still stands without any', () => {
  const fact = managerOutageFact({
    anchors: ANCHORS,
    selfNodeId: WORKER,
    nodes: [row(CONTROLLER), row(MANAGER, { live: false }), row(WORKER)],
  })
  const many = Array.from({ length: MANAGER_NOTICE_TASK_IDS_MAX + 5 }, (_, index) => `T${900 + index}`)
  const text = managerCoordinationNotice({ fact, taskIds: many, selfName: 'Worker 64' })
  const named = many.filter(id => text.includes(id))
  assert.equal(named.length, MANAGER_NOTICE_TASK_IDS_MAX,
    `the escalation named ${named.length} task ids instead of the declared cap of ${MANAGER_NOTICE_TASK_IDS_MAX}`)
  assert.ok(managerCoordinationNotice({ fact, taskIds: [], selfName: 'Worker 64' }),
    'a worker with no open task ids got no escalation at all')
  assert.equal(managerCoordinationNotice({ fact: null, taskIds: [] }), null)
})

/* ------------------------------------------------------------------ *
 * THE REAL HOST, DRIVEN.
 * ------------------------------------------------------------------ */

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

/* A stand-in for the installed payload's continuation controller. It records
   the options the host handed it and the session objects the host passed back
   in, so the two callbacks can be invoked with the host's OWN live values --
   not with a shape this test invented. */
function recordingContinuation() {
  const seen = { options: null, sessions: new Map() }
  const noop = () => null
  const stub = new Proxy({}, {
    get(_target, property) {
      if (property === 'started') return session => { seen.sessions.set(session.sessionId, session) }
      if (property === 'instructions') return () => null
      if (property === 'enabled') return () => false
      if (property === 'then') return undefined
      return noop
    },
  })
  return {
    seen,
    loader: () => ({
      createLedgerContinuation(options) {
        seen.options = options
        return stub
      },
    }),
  }
}

async function treeSession(host, engine, { sessionId, selfName, managerName, anchors }) {
  await host.startSession({
    sessionId,
    requestKeys: { treeAnchors: anchors, threadId: anchors.at(-1) },
    treeIdentity: { selfName, managerName },
  })
  await host.sendTurn({
    sessionId,
    text: managerName
      ? `Tree address: you are "${selfName}", and your manager is "${managerName}".\n\nBegin.`
      : `Tree address: you are "${selfName}", at the top of your tree.\n\nBegin.`,
    origin: 'brief',
  })
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: `${sessionId}-t1`, status: 'completed' })
}

test('the host offers the continuation controller a manager reading and an escalation route', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'wiring-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    assert.ok(seen.options, 'the host built no continuation controller at all')
    assert.equal(typeof seen.options.readManagerState, 'function',
      'the host gave the continuation controller no way to learn that a manager has stopped')
    assert.equal(typeof seen.options.onManagerUnavailable, 'function',
      'the host gave the continuation controller no route for the escalation')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a worker whose manager\'s provider died reads that manager as gone; a manager the person closed is not a failure', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'outage-'))
  const engine = require_(EXITING_ENGINE)
  engine.reset()
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: EXITING_ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    /* Start order is the fixture's index: controller 0, manager 1, worker 2. */
    await treeSession(host, engine, { sessionId: 'controller', selfName: 'Controller', managerName: null, anchors: [CONTROLLER] })
    await treeSession(host, engine, { sessionId: 'manager', selfName: 'Manager 6', managerName: 'Controller', anchors: [CONTROLLER, MANAGER] })
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })

    const worker = seen.sessions.get('worker')
    assert.ok(worker, 'the host never handed the continuation controller the worker session')
    assert.equal(seen.options.readManagerState(worker), null,
      'a running manager was read as an outage while it was still answering')

    /* THE MEASURED CASE. The manager's provider goes away and nobody asked it
       to -- which is what happened on 2026-09-15 and what left three workers
       sitting for three hours. */
    assert.equal(engine.exitAt(1), true, 'the fixture never produced a manager child to kill')
    /* WAIT FOR THE ENTRY TO BE GONE, NOT JUST FOR THE ENDING. cleanupEndedSession()
       removes the session from the host's map asynchronously, and a reading taken
       before that is standing on an 'ended' row that is about to disappear. The
       worker's continuation ticks every five seconds, so the state that actually
       matters is the one AFTER cleanup -- where the dead manager is indistinguishable
       from a circle this process never saw unless the ending was written down.
       Measured while building this suite: asserting in the transient window passed
       with the recording removed, which is a test agreeing with a defect. */
    assert.ok(await waitFor(() => host.sessionActivity('manager') === null),
      'the dead manager session never left the host, so this assertion would prove nothing')

    const fact = seen.options.readManagerState(worker)
    assert.ok(fact, 'the worker\'s manager died and the worker could not tell')
    assert.equal(fact.managerNodeId, MANAGER)
    assert.equal(fact.reason, 'session-unavailable')
    assert.equal(fact.ancestor?.sessionId, 'controller',
      'the worker had nowhere to escalate even though the Controller was still running')

    /* ONE OUTAGE, ONE EPISODE: the engine notifies at most once per episode, so
       a reading that changed every tick would notify the Controller every tick. */
    assert.equal(seen.options.readManagerState(worker).episodeId, fact.episodeId,
      'the same continuing outage read as a new episode, which would tell the ancestor again on every tick')
  } finally {
    await host.closeAll().catch(() => {})
    engine.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a manager the person deliberately closed is not reported to its worker as a failure', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'closed-'))
  const engine = require_(EXITING_ENGINE)
  engine.reset()
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: EXITING_ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    await treeSession(host, engine, { sessionId: 'controller', selfName: 'Controller', managerName: null, anchors: [CONTROLLER] })
    await treeSession(host, engine, { sessionId: 'manager', selfName: 'Manager 6', managerName: 'Controller', anchors: [CONTROLLER, MANAGER] })
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')

    /* The person pressed Stop. An ending they asked for is the close, not a
       failure -- the same rule endSessionFromExit() already keeps for a turn
       cut short by a requested close. */
    await host.closeSession({ sessionId: 'manager' }).catch(() => {})
    assert.equal(seen.options.readManagerState(worker), null,
      'a manager the person stopped on purpose was reported to its worker as an outage, which would escalate the person\'s own decision to the Controller')
  } finally {
    await host.closeAll().catch(() => {})
    engine.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an accepted escalation is retained before it returns, and reaches the live circle above the gap', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'escalate-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  const visible = []
  const unlisten = host.onEvent(packet => visible.push(packet))
  try {
    await treeSession(host, engine, { sessionId: 'controller', selfName: 'Controller', managerName: null, anchors: [CONTROLLER] })
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')

    const fact = managerOutageFact({
      anchors: ANCHORS,
      selfNodeId: WORKER,
      managerName: 'Manager 6',
      nodes: [
        { nodeId: CONTROLLER, sessionId: 'controller', name: 'Controller', live: true, consecutiveTurnFailures: 0 },
        { nodeId: MANAGER, sessionId: 'manager', name: 'Manager 6', live: false, consecutiveTurnFailures: 0 },
      ],
    })
    const before = visible.length
    const receipt = seen.options.onManagerUnavailable(worker, fact, ['T123'])

    /* SYNCHRONOUS. A promise is not a receipt: the engine decides on this
       answer inside the same tick it composes the worker's next turn. */
    assert.equal(typeof receipt?.then, 'undefined', 'the escalation answered with a promise instead of a receipt')
    assert.equal(receipt.accepted, true, `the host refused the escalation: ${receipt.reason}`)

    const held = host.managerCoordinationNotices()
    assert.equal(held.length, 1, 'the accepted escalation was not written down anywhere')
    assert.equal(held[0].episodeId, fact.episodeId)
    assert.equal(held[0].toSessionId, 'controller', 'the escalation was not addressed to the live ancestor')

    const shown = visible.slice(before).find(packet => packet.sessionId === 'controller'
      && packet.event?.type === 'assistant_text_delta'
      && packet.event.text.includes('Worker 64'))
    assert.ok(shown, 'the escalation was accepted but never put in front of the circle above the gap')
    assert.ok(shown.event.text.includes('T123'),
      'the ancestor was told a worker was stuck but not that it is still working')
  } finally {
    unlisten()
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('with no live ancestor the escalation is still accepted and the person can read it', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'noancestor-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  const visible = []
  const unlisten = host.onEvent(packet => visible.push(packet))
  try {
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')
    const fact = managerOutageFact({
      anchors: ANCHORS,
      selfNodeId: WORKER,
      managerName: 'Manager 6',
      nodes: [{ nodeId: MANAGER, sessionId: 'manager', name: 'Manager 6', live: false, consecutiveTurnFailures: 0 }],
    })
    assert.equal(fact.ancestor, null, 'this case is only meaningful with nobody above the manager')

    const before = visible.length
    const receipt = seen.options.onManagerUnavailable(worker, fact, ['T123'])
    assert.equal(receipt.accepted, true,
      'an escalation with nobody above it was dropped, which is the silent skip this codebase keeps re-finding')
    assert.equal(host.managerCoordinationNotices().at(-1)?.toSessionId, null)
    const shown = visible.slice(before).find(packet => packet.sessionId === 'worker'
      && packet.event?.type === 'assistant_text_delta'
      && packet.event.text.includes('Manager 6'))
    assert.ok(shown, 'with no ancestor to tell, the person was not told either')
  } finally {
    unlisten()
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an escalation is refused when its source session is no longer the one running', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'stale-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')
    const fact = managerOutageFact({
      anchors: ANCHORS,
      selfNodeId: WORKER,
      nodes: [{ nodeId: MANAGER, sessionId: 'manager', name: 'Manager 6', live: false, consecutiveTurnFailures: 0 }],
    })
    await host.closeSession({ sessionId: 'worker' }).catch(() => {})
    const receipt = seen.options.onManagerUnavailable(worker, fact, ['T123'])
    assert.equal(receipt.accepted, false,
      'a stopped session was still allowed to escalate on behalf of a tree it has left')
    assert.ok(typeof receipt.reason === 'string' && receipt.reason.length > 0,
      'the refusal did not name itself')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a fact the engine did not produce is refused by name rather than escalated', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'badfact-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  const { seen, loader } = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    await treeSession(host, engine, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')
    for (const bad of [null, {}, { episodeId: 'e', reason: 'made-up', managerNodeId: MANAGER }]) {
      const receipt = seen.options.onManagerUnavailable(worker, bad, [])
      assert.equal(receipt.accepted, false, `an unusable fact was escalated: ${JSON.stringify(bad)}`)
      assert.ok(typeof receipt.reason === 'string' && receipt.reason.length > 0, 'the refusal did not name itself')
    }
    assert.equal(host.managerCoordinationNotices().length, 0)
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
