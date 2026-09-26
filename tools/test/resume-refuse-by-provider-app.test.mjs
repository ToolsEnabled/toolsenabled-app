// A CONVERSATION RESUMED ON THE WRONG PROGRAM IS REFUSED BY NAME, BEFORE THE
// ENGINE IS CALLED AT ALL.
//
// THE DEFECT, measured: startSession validated `resumeThreadId` for SHAPE only
// (a non-empty string of at most 512 characters) and checked merely that some
// resume capability existed. It then routed that id to whichever engine
// `sessionProvider` named, unchecked. A Codex-minted id sent to Claude ran
// `claude --resume <codex id>`, which exited in about three seconds with "No
// conversation found with session ID" -- and the failure return had the same
// shape as a success, so nothing upstream could tell them apart.
//
// WHAT IS ASSERTED, and why it is not a source scan: the fixture engines RECORD
// every call, so "refused before the engine was reached" is a count that did not
// move. A host that computes the right verdict and then calls the engine anyway
// is exactly the failure reading the source could not see.
//
// ABSENT IS PERMITTED. Every thread minted before 1.0.42 carries no recorded
// provider, and refusing those would break every existing resume. The last two
// cases pin that the gate lets them through, so this fix cannot become the
// outage it exists to prevent.
//
//   node --test tools/test/resume-refuse-by-provider-app.test.mjs

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/* THE SCRATCH IS NOT UNDER node_modules, WHICH IS WHERE THE OTHER SUITES PUT
   THEIRS. In a worktree whose node_modules is a junction to a shared dependency
   store -- how every lane in this tree builds -- a scratch directory there
   cannot be removed: `rmSync` answers EPERM, and because the removal sits in the
   teardown it fails the case and hides whatever the assertions actually found.
   Measured here: five cases reported EPERM instead of their real result. A
   diagnostic that destroys its own evidence is worse than none, so this suite
   works in the OS temp directory and treats cleanup as best effort. */
const TEST_SCRATCH_ROOT = path.join(os.tmpdir(), 'toolsenabled-resume-provider-app-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })

const testWorkdir = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
const discard = directory => {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5 }) }
  catch { /* a scratch directory another process still holds is not this test's verdict */ }
}

const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const DUAL_ENGINE = path.join(ROOT, 'tools/test/fixtures/dual-engine/src/lib/agent-engine/codex-process.js')

const codexCalls = () => require_(DUAL_ENGINE).calls
const claudeResumeCalls = () =>
  require_(path.join(ROOT, 'tools/test/fixtures/dual-engine/src/lib/agent-engine/claude-cli-process.js')).resumeCalls
const codexResumeCount = () => codexCalls().filter(call => call && call.resumed).length

function withPlan(plan, run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  try { return run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

const guidedPlan = workdir => ({
  ok: true, tier: 'guided', isolated: true,
  threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
  env: { CODEX_HOME: path.join(workdir, 'agent-home') },
  servers: ['toolsenabled-readonly'],
})

async function withHost(prefix, run) {
  const workdir = testWorkdir(prefix)
  try {
    return await withPlan(guidedPlan(workdir), async () => {
      const host = createAgentHost({
        freeMemory: () => 64 * 1024 ** 3,
        enginePath: DUAL_ENGINE,
        defaultCwd: workdir,
        providerCommandResolver: () => path.join(workdir, 'stand-in.exe'),
      })
      try { return await run(host) } finally { await host.closeAll() }
    })
  } finally {
    discard(workdir)
  }
}

async function refusalFrom(run) {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

test('a Codex-minted conversation resumed on a Claude seat is refused by name, and the engine is never called', async () => {
  await withHost('mc-refuse-codex-on-claude-', async host => {
    const before = claudeResumeCalls().length
    const error = await refusalFrom(() => host.startSession({
      sessionId: 'refuse-codex-on-claude-1',
      tier: 'claude-opus',
      resumeThreadId: 'a-thread-codex-minted',
      resumeThreadProvider: 'codex',
    }))

    assert.ok(error, 'a cross-provider resume must be refused, not started')
    assert.equal(error.code, 'AGENT_RESUME_PROVIDER_MISMATCH',
      `expected the refusal, got ${error.code}: ${error.message}`)
    assert.match(error.message, /Codex/, 'the sentence must name the provider that owns the conversation')
    assert.match(error.message, /Claude/, 'the sentence must name the provider it was asked to resume on')
    assert.equal(claudeResumeCalls().length, before,
      'the refusal must come BEFORE the engine -- a resume reached the Claude engine')
  })
})

test('a Claude-minted conversation resumed on a Codex seat is refused by name, and the engine is never called', async () => {
  await withHost('mc-refuse-claude-on-codex-', async host => {
    const before = codexResumeCount()
    const error = await refusalFrom(() => host.startSession({
      sessionId: 'refuse-claude-on-codex-1',
      tier: 'luna',
      resumeThreadId: 'a-thread-claude-minted',
      resumeThreadProvider: 'claude',
    }))

    assert.ok(error, 'a cross-provider resume must be refused, not started')
    assert.equal(error.code, 'AGENT_RESUME_PROVIDER_MISMATCH',
      `expected the refusal, got ${error.code}: ${error.message}`)
    assert.match(error.message, /Claude/, 'the sentence must name the provider that owns the conversation')
    assert.match(error.message, /Codex/, 'the sentence must name the provider it was asked to resume on')
    assert.equal(codexResumeCount(), before,
      'the refusal must come BEFORE the engine -- a resume reached the Codex engine')
  })
})

test('a recorded provider this build cannot identify is refused, never assumed to match', async () => {
  await withHost('mc-refuse-unknown-', async host => {
    const before = claudeResumeCalls().length
    const error = await refusalFrom(() => host.startSession({
      sessionId: 'refuse-unknown-1',
      tier: 'claude-opus',
      resumeThreadId: 'a-thread-from-somewhere',
      resumeThreadProvider: 'some-engine-from-the-future',
    }))

    assert.ok(error, 'an unidentifiable recorded provider must be refused')
    assert.equal(error.code, 'AGENT_RESUME_PROVIDER_UNKNOWN',
      `expected the unknown-provider refusal, got ${error.code}: ${error.message}`)
    assert.equal(claudeResumeCalls().length, before,
      'nothing may reach the engine for a provider we cannot identify')
  })
})

test('a conversation resumed on the seat that minted it still reaches the engine', async () => {
  await withHost('mc-permit-match-', async host => {
    const before = claudeResumeCalls().length
    await host.startSession({
      sessionId: 'permit-match-1',
      tier: 'claude-opus',
      resumeThreadId: 'a-thread-claude-minted',
      resumeThreadProvider: 'claude',
    })
    assert.equal(claudeResumeCalls().length, before + 1,
      'a matching provider was refused; the resume never reached the engine')
  })
})

test('a conversation from before providers were recorded still resumes -- absent is legacy-permitted', async () => {
  await withHost('mc-permit-legacy-', async host => {
    const before = claudeResumeCalls().length
    await host.startSession({
      sessionId: 'permit-legacy-1',
      tier: 'claude-opus',
      resumeThreadId: 'a-thread-from-before-1042',
    })
    assert.equal(claudeResumeCalls().length, before + 1,
      'a pre-1.0.42 thread with no recorded provider was refused; every old conversation would be')
  })
})
