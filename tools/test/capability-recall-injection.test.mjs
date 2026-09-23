/* DOES THE PER-PROMPT TOOL SHORTLIST REACH THE ENGINE, AND ON THE RIGHT PATH.
 *
 * The engine side -- the index, the scoring, the silence on prompts that
 * deserve it, the agent.capability_recall row and its enforcement -- is proved
 * by the engine suite tests/capability-recall.test.js. THIS suite proves the
 * half that lives here and can rot on its own: the HOST's per-turn assembly.
 *
 * Its sister suite, tools/test/tool-summary-injection.test.mjs, proves the
 * SESSION-START note. The two features look alike and are wired differently,
 * and the difference is the thing most likely to be got wrong by whoever
 * touches this next:
 *
 *   tool summary        composed once at start, parked on session.pendingToolSummary,
 *                       sent on the FIRST turn, then cleared.
 *   capability recall    composed on EVERY turn from that turn's own text, parked
 *                       nowhere, cleared by nothing.
 *
 * Put this on the pendingToolSummary path and it would answer turn one and go
 * quiet forever, which is a feature that looks present and does almost nothing.
 * So the first test below sends TWO turns and requires a block on both.
 *
 * Everything is asserted on what the ENGINE ADAPTER RECEIVED, never on an
 * intermediate the host could compute and then drop.
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

const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))

const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const SUMMARYLESS_ENGINE = path.join(ROOT, 'tools/test/fixtures/summaryless-engine/src/lib/agent-engine/codex-process.js')
const RECALL_FIXTURE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/capability-recall/index.js')
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-capability-recall-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

function withEnvironment(values, run) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return Promise.resolve()
    .then(run)
    .finally(restore)
}

function withPlan(plan, run) {
  return withEnvironment({ MC_TEST_CONFINEMENT_PLAN: JSON.stringify(plan) }, run)
}

function adapterCalls() {
  return require_(CONFINED_ENGINE).adapterCalls
}

function recallCalls() {
  return require_(RECALL_FIXTURE).calls
}

function guidedPlan(workdir) {
  return {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly'],
  }
}

/* End the turn the way the engine would, through the session's own event
   channel, so the next send is legal. */
function completeTurn(turnId) {
  const startCall = require_(CONFINED_ENGINE).calls.at(-1)
  startCall.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId, status: 'completed' })
}

test('the block rides EVERY turn, composed from that turn\'s own words', async () => {
  const workdir = testScratch('mc-capability-recall-')
  try {
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: 'on', MC_TEST_TOOL_SUMMARY: 'off' }, () =>
      withPlan(guidedPlan(workdir), async () => {
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
        await host.startSession({ sessionId: 'recall-1' })

        const before = adapterCalls().length
        const askedBefore = recallCalls().length

        await host.sendTurn({ sessionId: 'recall-1', text: 'Take a screenshot of my screen.' })
        const first = adapterCalls()[before]
        assert.equal(first.method, 'sendTurn')
        assert.ok(first.request.text.startsWith('Take a screenshot of my screen.'),
          'the person\'s own words no longer come first')
        assert.ok(first.request.text.includes('FIXTURE CAPABILITY BLOCK (Take a screenshot of my screen.)'),
          `the first turn carries no capability block; the engine received: ${first.request.text.slice(0, 300)}`)

        completeTurn('t1')

        await host.sendTurn({ sessionId: 'recall-1', text: 'Now read my email.' })
        const second = adapterCalls()[before + 1]
        assert.ok(second.request.text.includes('FIXTURE CAPABILITY BLOCK (Now read my email.)'),
          'THE WHOLE POINT: the second turn got no block, or got the first turn\'s block. This is per prompt, '
          + `not per session. The engine received: ${second.request.text.slice(0, 300)}`)

        /* And it is composed from THIS turn, not replayed: the module was asked
           once per turn, each time with that turn's exact words. */
        const asked = recallCalls().slice(askedBefore).filter(entry => entry.kind === 'recommend')
        assert.deepEqual(asked.map(entry => entry.promptText),
          ['Take a screenshot of my screen.', 'Now read my email.'],
          'the recommender was not asked once per turn with that turn\'s own text')

        await host.closeAll()
      }))
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('capability recall remains per-turn when the session-start tool summary is also enabled', async () => {
  const workdir = testScratch('mc-capability-recall-with-summary-')
  try {
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: 'on', MC_TEST_TOOL_SUMMARY: undefined }, () =>
      withPlan(guidedPlan(workdir), async () => {
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
        await host.startSession({ sessionId: 'recall-with-summary-1' })
        const startCall = require_(CONFINED_ENGINE).calls.find(call => call.cwd === workdir)
        const before = adapterCalls().length

        await host.sendTurn({ sessionId: 'recall-with-summary-1', text: 'Capture the first screen.' })
        const firstText = adapterCalls()[before].request.text
        assert.ok(firstText.includes('FIXTURE TOOL SUMMARY (guided)'),
          'the first turn did not receive the enabled session-start tool summary')
        assert.ok(firstText.includes('FIXTURE CAPABILITY BLOCK (Capture the first screen.)'),
          'the first turn did not receive its per-turn capability block alongside the tool summary')

        startCall.onEvent({
          type: 'turn_completed',
          threadId: 'thread-1',
          turnId: 't1',
          status: 'completed',
        })

        await host.sendTurn({ sessionId: 'recall-with-summary-1', text: 'Capture the second screen.' })
        const secondText = adapterCalls()[before + 1].request.text
        assert.ok(secondText.includes('FIXTURE CAPABILITY BLOCK (Capture the second screen.)'),
          'the second turn lost capability recall when the session-start summary was cleared')
        assert.ok(!secondText.includes('FIXTURE TOOL SUMMARY'),
          'the session-start tool summary leaked onto the second turn')

        await host.closeAll()
      }))
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a recommender that answers with an empty block appends nothing', async () => {
  const workdir = testScratch('mc-capability-recall-silent-')
  try {
    /* The fixture is silent unless told otherwise, which is the real module's
       common answer: "hi", "thanks" and "keep going" deserve nothing. An empty
       text must produce a turn byte-identical to the one before this feature. */
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: undefined, MC_TEST_TOOL_SUMMARY: 'off' }, () =>
      withPlan(guidedPlan(workdir), async () => {
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
        await host.startSession({ sessionId: 'recall-silent-1' })
        const before = adapterCalls().length
        await host.sendTurn({ sessionId: 'recall-silent-1', text: 'thanks, keep going' })
        const first = adapterCalls()[before]
        assert.equal(first.request.text, 'thanks, keep going',
          'an empty block was appended as a block; silence must cost the turn nothing at all')
        await host.closeAll()
      }))
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the session\'s permission-tier allowlist is what the recommender is given', async () => {
  const workdir = testScratch('mc-capability-recall-allow-')
  try {
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: 'on', MC_TEST_TOOL_SUMMARY: 'off' }, () =>
      withPlan(guidedPlan(workdir), async () => {
        const askedBefore = recallCalls().length
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
        await host.startSession({ sessionId: 'recall-allow-1' })

        /* Derived ONCE, at start, from the plan that is binding the session --
           so the block can never name a tool this level would refuse, and can
           never drift from the level actually enforced. */
        const derivation = recallCalls().slice(askedBefore).filter(entry => entry.kind === 'allowlist')
        assert.equal(derivation.length, 1, 'the allowlist was derived a number of times other than once per session')
        assert.equal(derivation[0].tier, 'guided',
          'the allowlist was derived for a different level than the one binding the session')

        await host.sendTurn({ sessionId: 'recall-allow-1', text: 'Take a screenshot.' })
        const asked = recallCalls().slice(askedBefore).find(entry => entry.kind === 'recommend')
        assert.ok(asked, 'the recommender was never asked')
        assert.ok(asked.allowedIds instanceof Set, 'the recommender was asked with no allowlist at all')
        assert.deepEqual([...asked.allowedIds].sort(), ['guided.first_tool', 'guided.second_tool'],
          'the recommender was handed something other than this session\'s tier allowlist')

        await host.closeAll()
      }))
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a plan that wired no servers is never given a block', async () => {
  const workdir = testScratch('mc-capability-recall-noservers-')
  try {
    /* The measured Claude shape: a valid plan, no MCP servers wired. Naming
       tools to a session that cannot call any is the same lie the tool note
       exists to end, once per message instead of once per session. */
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: 'on', MC_TEST_TOOL_SUMMARY: 'off' }, () =>
      withPlan({ ...guidedPlan(workdir), servers: [] }, async () => {
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
        await host.startSession({ sessionId: 'recall-noservers-1' })
        const before = adapterCalls().length
        await host.sendTurn({ sessionId: 'recall-noservers-1', text: 'Take a screenshot.' })
        assert.equal(adapterCalls()[before].request.text, 'Take a screenshot.',
          'a session with no wired servers was handed a shortlist of tools it cannot call')
        await host.closeAll()
      }))
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a payload with no capability-recall module starts sessions and appends nothing', async () => {
  const workdir = testScratch('mc-capability-recall-absent-')
  try {
    /* The guarded require returns null and the product is exactly what it was.
       A payload cut before this module existed must keep working: a missing
       addition must never become a dead turn. */
    await withEnvironment({ MC_TEST_CAPABILITY_RECALL: 'on' }, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: SUMMARYLESS_ENGINE,
        defaultCwd: workdir,
        confinementPlanner: () => guidedPlan(workdir),
      })
      await host.startSession({ sessionId: 'recall-absent-1' })
      const engine = require_(SUMMARYLESS_ENGINE)
      const before = engine.adapterCalls.length
      await host.sendTurn({ sessionId: 'recall-absent-1', text: 'Old payload, ordinary turn.' })
      assert.equal(engine.adapterCalls[before].request.text, 'Old payload, ordinary turn.',
        'an older payload cannot produce a block, so nothing may be appended')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the host keeps none of the person\'s words for this feature', async () => {
  /* The block rides a person's turn, so the thing it reads is the most
     sensitive text in the product. The host may pass turnText to the
     recommender and must not park it, spool it for this feature, or put it in
     any record of its own. Asserted on the source because the absence of a
     write is not observable from the outside. */
  const host = require_('node:fs').readFileSync(path.join(ROOT, 'shell/agent-host.cjs'), 'utf8')
  const composer = host.slice(host.indexOf('function composeCapabilityNote'))
  const body = composer.slice(0, composer.indexOf('\n}\n') + 2)
  assert.doesNotMatch(body, /audit|writeFile|appendFile|spool|console\.|log\(/i,
    `the per-turn composer writes or logs something; it may only read the turn and return a block:\n${body}`)
  assert.match(body, /capabilityRecall\.recommend\(turnText, \{ allowedIds: session\.capabilityAllowedIds \}\)/,
    'the composer no longer passes the turn text straight through with only the allowlist beside it')
})
