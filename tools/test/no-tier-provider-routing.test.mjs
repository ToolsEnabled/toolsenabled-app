// WHICH ENGINE A NO-TIER START REACHES, ON A MACHINE THAT ONLY HAS ONE.
//
// THE DEFECT, driven on a Claude-only foreign machine by the cross-machine
// lane: with no ~/.codex/auth.json anywhere, pressing Start from the agent
// page refused -- even with Claude installed and signed in -- because the
// no-tier start path assumed a CODEX confinement plan regardless of what the
// machine actually has. The provider-login lane fixed the refusal's WORDS
// (6a3ab66); this suite pins the ROUTING: the no-tier default resolves from
// the machine's real presence, per provider.
//
// Asserted on WHICH FIXTURE ENGINE RECORDED THE START, never on source text:
// a host that computes the right provider and then starts the other engine is
// exactly the failure a source scan cannot see.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { platformSkipReason } from '../lib/test-suite-result.mjs'
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
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-no-tier-provider-routing-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })

function testWorkdir(prefix) {
  return mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
}

const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
/* The DUAL-engine fixture root, deliberately not confined-engine: that root is
   COMPLETE_ENGINE for the availability suite, whose fifth-precondition case
   needs a payload with NO claude module -- a claude module there opens the
   claudeCouldStart bypass on any machine where the claude program resolves.
   See tools/test/fixtures/dual-engine/src/lib/agent-engine/codex-process.js. */
const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/dual-engine/src/lib/agent-engine/codex-process.js')

function codexCalls() { return require_(CONFINED_ENGINE).calls }
function claudeCalls() {
  return require_(path.join(ROOT, 'tools/test/fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')).calls
}
function claudeResumeCalls() {
  return require_(path.join(ROOT, 'tools/test/fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')).resumeCalls
}

function withPlan(plan, run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  try { return run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

function guidedPlan(workdir) {
  return {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly'],
  }
}

test('a no-tier start on a claude-only machine reaches the claude engine', async () => {
  const workdir = testWorkdir('mc-route-claude-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const claudeExecutable = path.join(workdir, 'claude.exe')
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'claude',
        providerCommandResolver: provider => provider === 'claude' ? claudeExecutable : null,
      })
      const codexBefore = codexCalls().length
      const claudeBefore = claudeCalls().length
      await host.startSession({ sessionId: 'route-claude-1' })
      assert.equal(claudeCalls().length, claudeBefore + 1,
        'the claude engine never saw the start; the no-tier path still assumes codex')
      assert.equal(codexCalls().length, codexBefore,
        'the codex engine was started on a machine the probe said cannot serve codex')
      assert.equal(
        claudeCalls().at(-1).command,
        claudeExecutable,
        'the Claude engine guessed a different executable from the one presence resolved',
      )
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a no-tier start where codex serves keeps codex, exactly as before', async () => {
  const workdir = testWorkdir('mc-route-codex-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'codex',
      })
      const codexBefore = codexCalls().length
      await host.startSession({ sessionId: 'route-codex-1' })
      assert.equal(codexCalls().length, codexBefore + 1, 'the ordinary codex default no longer starts codex')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Linux Codex launches the exact executable from the current provider resolver', {
  skip: platformSkipReason('linux'),
}, async () => {
  const workdir = testWorkdir('mc-route-linux-codex-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const executable = path.join(workdir, 'user-local', 'codex')
      const resolvedProviders = []
      const host = createAgentHost({
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'codex',
        providerCommandResolver(provider) {
          resolvedProviders.push(provider)
          return provider === 'codex' ? executable : null
        },
      })
      try {
        await host.startSession({ sessionId: 'route-linux-codex' })
        assert.deepEqual(resolvedProviders, ['codex'])
        assert.equal(codexCalls().at(-1).command, executable,
          'the host must not discard a discovered Linux executable and retry a stale PATH')
        assert.deepEqual(codexCalls().at(-1).threadOptions,
          { sandbox: 'read-only', approvalPolicy: 'never' })
        assert.equal(codexCalls().at(-1).env.CODEX_HOME, path.join(workdir, 'agent-home'))
      } finally { await host.closeAll() }
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an explicit Claude tier launches the exact native executable presence resolved', async () => {
  const workdir = testWorkdir('mc-route-explicit-claude-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const claudeExecutable = path.join(workdir, 'native-claude.exe')
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'codex',
        providerCommandResolver: provider => provider === 'claude' ? claudeExecutable : null,
      })
      const claudeBefore = claudeCalls().length
      await host.startSession({ sessionId: 'route-explicit-claude-1', tier: 'claude-sonnet' })
      assert.equal(claudeCalls().length, claudeBefore + 1,
        'the explicit Claude tier did not reach the Claude engine')
      assert.equal(claudeCalls().at(-1).command, claudeExecutable,
        'the explicit Claude tier did not preserve the resolved native executable')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a resumed Claude session keeps the exact native executable presence resolved', async () => {
  const workdir = testWorkdir('mc-route-resume-claude-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const claudeExecutable = path.join(workdir, 'native-claude.exe')
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        providerCommandResolver: () => claudeExecutable,
      })
      const resumeBefore = claudeResumeCalls().length
      await host.startSession({
        sessionId: 'route-resume-claude-1',
        tier: 'claude-opus',
        resumeThreadId: 'existing-claude-thread',
      })
      assert.equal(claudeResumeCalls().length, resumeBefore + 1,
        'the resumed Claude session did not reach the resume engine')
      assert.equal(claudeResumeCalls().at(-1).command, claudeExecutable,
        'the resumed Claude session did not preserve the resolved native executable')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an uncertain provider-command resolution preserves the Claude engine fallback', async () => {
  const workdir = testWorkdir('mc-route-command-fallback-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'claude',
        providerCommandResolver: () => { throw new Error('resolution uncertain') },
      })
      await host.startSession({ sessionId: 'route-command-fallback-1' })
      assert.equal(Object.hasOwn(claudeCalls().at(-1), 'command'), false,
        'an uncertain resolver replaced the engine fallback with an invented command')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a probe that throws falls back to the codex path this host has always taken', async () => {
  const workdir = testWorkdir('mc-route-fallback-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => { throw new Error('probe fault') },
      })
      const codexBefore = codexCalls().length
      await host.startSession({ sessionId: 'route-fallback-1' })
      assert.equal(codexCalls().length, codexBefore + 1,
        'a broken probe must degrade to the path that existed before it, not to a refusal')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an explicit tier always outranks the probe', async () => {
  const workdir = testWorkdir('mc-route-explicit-')
  try {
    await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: CONFINED_ENGINE,
        defaultCwd: workdir,
        startProviderProbe: () => 'claude',
      })
      const codexBefore = codexCalls().length
      await host.startSession({ sessionId: 'route-explicit-1', tier: 'luna' })
      assert.equal(codexCalls().length, codexBefore + 1,
        'a person\'s explicit codex seat was rerouted by the presence probe')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
