/* C6/C7 host mechanics against the recording fixture engine: rewind rebinds
 * the thread, the approval answer reaches the adapter in the adapter's own
 * shape, and per-turn options ride a real sendTurn. NO LIVE APPROVAL PROBE IS
 * POSSIBLE and that limitation is stated here on purpose: approvalPolicy is
 * 'never' at every tier, so nothing fires an approval_request on a real
 * session today — the reply path ships FIRST, which is the ordering the
 * confinement module's own comment demands. The rewind SEMANTICS were proven
 * live separately (tools/agent-rewind-probe.mjs, 2026-08-14: PASS). */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
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
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))

const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-session-reply-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

function withPlan(plan, run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  })
}

function adapterCalls() {
  return require_(CONFINED_ENGINE).adapterCalls
}

function plannedHost(workdir) {
  const plan = {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
  }
  return withPlan(plan, async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
    await host.startSession({ sessionId: 'reply-paths-1' })
    return host
  })
}

test('rewind forks at the named turn and every later send rides the forked thread', async () => {
  const workdir = testScratch('mc-reply-paths-')
  const host = await plannedHost(workdir)
  const before = adapterCalls().length
  const rewound = await host.rewindSession({ sessionId: 'reply-paths-1', turnId: 'turn-2' })
  assert.equal(rewound.threadId, 'thread-forked')
  const fork = adapterCalls()[before]
  assert.equal(fork.method, 'forkThread')
  assert.equal(fork.threadId, 'thread-1', 'the fork must name the thread the session held')
  assert.equal(fork.forkOptions.lastTurnId, 'turn-2', 'the fork must name the turn the person picked')
  await host.sendTurn({ sessionId: 'reply-paths-1', text: 'after the rewind' })
  const send = adapterCalls()[adapterCalls().length - 1]
  assert.equal(send.method, 'sendTurn')
  assert.equal(send.request.threadId, 'thread-forked',
    'a send after a rewind still rode the OLD thread — the erased half would be back')
})

test('the approval answer reaches the adapter in the adapter\'s own shape', async () => {
  const workdir = testScratch('mc-reply-paths-')
  const host = await plannedHost(workdir)
  const before = adapterCalls().length
  const answered = await host.answerApproval({ sessionId: 'reply-paths-1', approvalId: 'codex:approve:1', decision: 'decline' })
  assert.equal(answered.decision, 'decline')
  const call = adapterCalls()[before]
  assert.equal(call.method, 'answerApproval')
  assert.deepEqual(call.answer, { approvalId: 'codex:approve:1', response: { decision: 'decline' } },
    'the host must speak the adapter\'s exact answer shape — a second dialect is how replies stop landing')
})

test('a per-turn model option rides the wire with the plan\'s policy over it', async () => {
  const workdir = testScratch('mc-reply-paths-')
  const host = await plannedHost(workdir)
  await host.sendTurn({ sessionId: 'reply-paths-1', text: 'switch', options: { model: 'gpt-5.6-terra' } })
  const send = adapterCalls()[adapterCalls().length - 1]
  assert.equal(send.method, 'sendTurn')
  assert.deepEqual(send.request.options, { model: 'gpt-5.6-terra', approvalPolicy: 'never' },
    'the optioned turn must carry the chosen model AND the plan\'s own policy, nothing else')
})

/* THE DEFECT: shell/agent-command-surface.cjs reads a session's tier once, at
 * start, into its own session map, and every row this app signs into
 * agent-turn-usage-records.jsonl for the life of that session carries
 * whatever it read then (shell/main.cjs noteAgentTurnUsage). "Switch model" is
 * real and sticky -- the turn above actually rides gpt-5.6-terra -- and until
 * sendTurn() said which TIER that model landed on, nothing could move the
 * session's recorded label to match, so every later turn's tokens signed into
 * the ledger under the tier the session merely started on. These two pin the
 * resolution sendTurn() must hand back so the command surface can correct it. */
test('a per-turn model switch resolves the TIER it landed on, not only the model string', async () => {
  const workdir = testScratch('mc-reply-paths-')
  const host = await plannedHost(workdir)
  const sent = await host.sendTurn({ sessionId: 'reply-paths-1', text: 'switch to sol', options: { model: 'gpt-5.6-sol' } })
  assert.equal(sent.tier, 'sol',
    'a turn that actually switched models must resolve which tier it now runs on -- the ledger label has nowhere else to read it from')
})

test('a turn with no model override resolves no tier at all', async () => {
  const workdir = testScratch('mc-reply-paths-')
  const host = await plannedHost(workdir)
  const sent = await host.sendTurn({ sessionId: 'reply-paths-1', text: 'plain turn, no switch' })
  assert.equal(sent.tier, undefined, 'a turn that named no model must not claim one -- inventing a tier here is the same class of lie a wrong one is')
})

test('the renderer half exists: the approval card is event-driven and answers through the channel', () => {
  const { readFileSync } = require_('node:fs')
  const view = readFileSync(path.join(ROOT, 'src/views/computers.js'), 'utf8')
  assert.match(view, /renderApprovalCard\(sessionId, sessionPendingApprovals\.get\(sessionId\)\)/, 'the next pending approval no longer reaches the card')
  /* Bounded by the function's own end rather than by a byte count: a comment
     added inside the card used to push the answer call past a fixed 2400-byte
     window and turn a green pin red for no behavioural reason. */
  const card = view.slice(view.indexOf('function renderApprovalCard'), view.indexOf('/* ---- STANDING REQUESTS'))
  assert.match(card, /approvalCardChoices\(approval\.availableDecisions, approval\.decisionKinds\)/,
    'the card must read its choices from the request the engine sent')
  assert.match(card, /choices\.decisions\.map/, 'the card must offer exactly the decisions the request named')
  assert.match(card, /settleApproval\(sessionId, approval\.approvalId, decision\)/,
    'the card no longer uses the shared answer path')
  const answer = view.slice(view.indexOf('async function settleApproval'), view.indexOf('function renderApprovalCard'))
  assert.match(answer, /bridge\?\.answerApproval\?\.\(\{ sessionId, approvalId, decision \}\)/)
  const activity = sessionActivityEvent({
    sessionId: 'reply-paths-1',
    event: {
      type: 'approval_request',
      approval: {
        approvalId: 'codex:approve:reader',
        kind: 'commandExecution',
        availableDecisions: ['accept', 'decline'],
        details: { command: 'printf reader' },
      },
    },
  }, 'reply-paths-1')
  assert.deepEqual(activity?.availableDecisions, ['accept', 'decline'],
    'the approval reader must carry the request\'s decision vocabulary to the card')
})
