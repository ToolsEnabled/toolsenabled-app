// DOES THE STANDARD TOOL NOTE ACTUALLY REACH THE SESSION -- BOTH WAYS.
//
// The owner's requirement: agents must be told what tools exist here without
// the person teaching each one by hand, as a standard note with a setting to
// turn it off. The engine side (derivation from the measured surface, the
// token budget, the agent.tool_summary registry row) is proved by the engine
// suite tests/agent-tool-summary.test.js. THIS suite proves the half that can
// silently rot on its own: the HOST's brief assembly.
//
// Three behaviours, each asserted on what the ENGINE ADAPTER RECEIVED rather
// than on any intermediate the host could compute and then ignore:
//
//   ON       the first turn of a new session carries the person's words FIRST
//            and the note after them; the second turn carries no note.
//   OFF      a module answering { enabled: false } injects nothing.
//   ABSENT   a payload cut before the module existed injects nothing and the
//            session still starts -- a missing feature must never become a
//            dead product.

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
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-tool-summary-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

function withPlan(plan, run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  try { return run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

function adapterCalls() {
  return require_(CONFINED_ENGINE).adapterCalls
}

function summaryCalls() {
  return require_(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-tool-summary.js')).calls
}

function guidedPlan(workdir) {
  return {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    /* The note is gated on the plan having actually wired the product's own
       servers; a plan that wired none must inject nothing. */
    servers: ['toolsenabled-readonly'],
  }
}

test('the first turn carries the note after the person\'s words, and only the first', async () => {
  const workdir = testScratch('mc-tool-note-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const askedBefore = summaryCalls().length
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      await host.startSession({ sessionId: 'note-on-1' })

      const asked = summaryCalls()[askedBefore]
      assert.ok(asked, 'the host never asked the tool-summary module for a note')
      assert.equal(asked.tier, 'guided', 'the note was requested for a different level than the one binding the session')

      const before = adapterCalls().length
      await host.sendTurn({ sessionId: 'note-on-1', text: 'Read the notes folder and summarize it.' })
      const first = adapterCalls()[before]
      assert.equal(first.method, 'sendTurn')
      assert.ok(first.request.text.startsWith('Read the notes folder and summarize it.'),
        'the person\'s own words no longer come first')
      assert.ok(first.request.text.includes('FIXTURE TOOL SUMMARY (guided)'),
        `the first turn carries no tool note; the engine received: ${first.request.text.slice(0, 200)}`)

      /* End the first turn the way the engine would, through the session's own
         event channel, so the second send is legal. */
      const startCall = require_(CONFINED_ENGINE).calls.at(-1)
      startCall.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

      await host.sendTurn({ sessionId: 'note-on-1', text: 'Now the second thing.' })
      const second = adapterCalls()[before + 1]
      assert.equal(second.request.text, 'Now the second thing.',
        'the note leaked onto a later turn; it belongs to the brief and nowhere else')

      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a plan that wired no servers injects nothing, whatever the module says', async () => {
  const workdir = testScratch('mc-tool-note-noservers-')
  try {
    /* A valid plan that wired no MCP servers. A note about tools the session
       cannot call is the lie this feature exists to end, pointed the other way.

       THIS SHAPE IS NO LONGER "THE MEASURED CLAUDE SHAPE", and the comment here
       said it was until 2026-09-17. Claude's plan now carries servers (the
       payload exports claudeToolsSessionPlan), so naming a live provider here
       taught the wrong fact about the product. The shape is still exactly the
       one this gate exists for, so the assertion is unchanged; only the claim
       about who produces it is withdrawn. Which providers actually wire servers
       is measured against the real planner in
       tools/test/optimized-api-provider-reach.test.mjs rather than asserted
       from a hand-written plan here. */
    await withPlan({ ...guidedPlan(workdir), servers: [] }, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      await host.startSession({ sessionId: 'note-noservers-1' })
      const before = adapterCalls().length
      await host.sendTurn({ sessionId: 'note-noservers-1', text: 'No toolkit was wired here.' })
      const first = adapterCalls()[before]
      assert.equal(first.request.text, 'No toolkit was wired here.',
        'a session with no wired servers was handed a note about tools it cannot call')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a module answering enabled:false injects nothing', async () => {
  const workdir = testScratch('mc-tool-note-off-')
  process.env.MC_TEST_TOOL_SUMMARY = 'off'
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
      await host.startSession({ sessionId: 'note-off-1' })
      const before = adapterCalls().length
      await host.sendTurn({ sessionId: 'note-off-1', text: 'Quiet start.' })
      const first = adapterCalls()[before]
      assert.equal(first.request.text, 'Quiet start.',
        'the setting is off and the note was injected anyway -- the switch is a lie')
      await host.closeAll()
    })
  } finally {
    delete process.env.MC_TEST_TOOL_SUMMARY
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a payload with no tool-summary module starts sessions and injects nothing', async () => {
  const workdir = testScratch('mc-tool-note-absent-')
  try {
    /* The plan arrives through the constructor because this fixture root
       predates the confinement module too; what is under test is only the
       summary loader's absence path. */
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
      enginePath: SUMMARYLESS_ENGINE,
      defaultCwd: workdir,
      confinementPlanner: () => guidedPlan(workdir),
    })
    await host.startSession({ sessionId: 'note-absent-1' })
    const engine = require_(SUMMARYLESS_ENGINE)
    const before = engine.adapterCalls.length
    await host.sendTurn({ sessionId: 'note-absent-1', text: 'Old payload, ordinary start.' })
    const first = engine.adapterCalls[before]
    assert.equal(first.request.text, 'Old payload, ordinary start.',
      'an older payload cannot produce a note, so nothing may be injected')
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
