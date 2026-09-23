/* THE THREE CONFINEMENT PLANS OF ONE AGENT START, AND THE ORDER OF THE
 * REFUSALS BETWEEN THEM.
 *
 * WHAT THIS SUITE EXISTS TO STOP. startSession() plans the recorded level three
 * times: once with no account (synchronously, before startSession returns),
 * once when rotation has chosen an account, and once when the owner host has
 * issued the session credential. MEASURED 2026-09-03 against the real payload
 * planner on this machine: one plan costs 28.7-43.8 ms and 136 lstat calls, and
 * three of them cost 77.9-94.2 ms of every agent start. That is an obvious
 * thing to "optimise", and every obvious way to do it moves a refusal:
 *
 *   - skipping the base plan moves five refusals that do not depend on the
 *     account off the synchronous path, so a caller receives a session handle
 *     for a start that was always going to fail;
 *   - skipping the account-pinned plan moves the account's refusals PAST the
 *     credential mint and bind, so the owner host issues authority for a
 *     session that must not run.
 *
 * Both are the same defect this codebase keeps re-finding: a security answer
 * arriving after something has already been handed out. So the assertions below
 * are about WHEN each refusal happens, not only that it happens -- an exception
 * from the call is a different fact from a rejected promise, and "the account
 * resolver was never asked" is a different fact from "the start failed".
 *
 * THE MEASURED CHANGE THIS SUITE GUARDS. The launch environment is built once
 * per DISTINCT plan environment instead of once per plan (sessionLaunchEnvironments
 * in shell/agent-host.cjs). MEASURED 2026-09-03: one build costs 5.0-7.3 ms over
 * 92 variables, and the shipped Claude plan carries a byte-identical env in all
 * three plans. The last two tests pin both halves of that: an unchanged layer is
 * built once, and a layer that CHANGES is built again and re-asserted -- which
 * is why the foreign-profile and billing refusals below are driven from the
 * pinned and credential-bound plans as well as from the base one.
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
const ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const SCRUB = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/providers/subscription-launch-env.js')
const SCRATCH = testScratchRoot('.toolsenabled-confinement-plan-order-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const LAUNCH_CONTEXT = 'ToolsEnabled agent session'
const ISSUED = Buffer.alloc(32, 0x41).toString('base64url')

const engineCalls = () => require_(ENGINE).calls
// Counted by CONTEXT, so an unrelated scrub by the fixture engine cannot be
// mistaken for one of this start's launch environments.
const launchBuilds = () => require_(SCRUB).calls.filter(call => call.context === LAUNCH_CONTEXT).length

function okPlan(home, over = {}) {
  return {
    ok: true,
    tier: 'guided',
    isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    servers: [],
    ...over,
    env: { CODEX_HOME: home, ...(over.env || {}) },
  }
}

/* One start, wired so every seam it consults is observable: which options each
 * plan was asked for, whether the account was ever resolved, whether a
 * credential was ever bound, and whether the engine child was ever started.
 *
 * `plans` is a function of the CALL INDEX rather than a fixed list, because the
 * property under test is the order of the three calls -- a fixture that answered
 * the same thing every time could not tell the second from the third. */
function startFixture({ plans, account = { name: 'work', resolvedHome: null }, bound = true, extras = null } = {}) {
  const workdir = mkdtempSync(path.join(SCRATCH, 'plan-order-'))
  const asked = []
  const resolved = []
  const bindings = []
  const revocations = []
  const home = path.join(workdir, 'agent-home')
  const accountHome = path.join(workdir, 'account-home')
  const chosen = account ? { ...account, resolvedHome: account.resolvedHome || accountHome } : null
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner(options) {
      asked.push({ ...options })
      return plans(asked.length - 1, { home, accountHome })
    },
    ...(extras ? { sessionEnvironmentExtras: extras } : {}),
    ...(chosen ? {
      async accountResolver(request) {
        resolved.push({ ...request })
        return { rotated: true, account: chosen }
      },
    } : {}),
    sessionAuthority: {
      async bind(binding) {
        bindings.push({ ...binding })
        return bound
          ? { bound: true, mode: 'owner-host', credential: ISSUED }
          : { bound: false, mode: 'in-process', credential: null }
      },
      async revoke(binding) {
        revocations.push({ ...binding })
        return { revoked: true }
      },
    },
  })
  return { host, workdir, asked, resolved, bindings, revocations, home, accountHome, chosen }
}

async function withFixture(options, run) {
  const fixture = startFixture(options)
  try {
    return await run(fixture)
  } finally {
    try { await fixture.host.closeAll() } catch { /* a refused start has nothing open */ }
    rmSync(fixture.workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

/* ---------- what the three plans are, and in which order ---------- */

test('one start plans the level three times: no account, then the account, then the issued credential', async () => {
  await withFixture({
    plans: (index, { home, accountHome }) => okPlan(index === 0 ? home : accountHome),
  }, async ({ host, asked, resolved, bindings, chosen }) => {
    const before = engineCalls().length
    await host.startSession({ sessionId: 'plan-order-three' })

    assert.equal(asked.length, 3,
      'a start that pins an account and binds a credential no longer plans the level for each of those decisions')

    // THE BASE PLAN CARRIES NO ACCOUNT, and that is the load-bearing half: every
    // refusal that does not depend on which sign-in was chosen must be reachable
    // before the resolver, which costs a child process, is ever asked.
    assert.equal(Object.hasOwn(asked[0], 'account'), false,
      'the first plan was given an account, so the refusals that do not depend on one now wait for the resolver')
    assert.equal(asked[0].sessionCredential, null)

    assert.deepEqual(asked[1].account, chosen,
      'the second plan did not re-plan for the account rotation chose')
    assert.equal(asked[1].sessionCredential, null,
      'the second plan carried a credential before the owner host had issued one')

    assert.deepEqual(asked[2].account, chosen,
      'the credential-bound plan dropped the chosen account, so the session would run from the default home')
    assert.equal(asked[2].sessionCredential, ISSUED,
      'the third plan did not carry the exact credential the owner host issued')

    // The resolver is asked once, after the base plan and before the bind.
    assert.equal(resolved.length, 1)
    assert.equal(bindings.length, 1)
    assert.equal(engineCalls().length, before + 1, 'the child was not started exactly once')
  })
})

test('a resume asks for the exact account that owns its thread while a fresh start keeps ordinary rotation', async () => {
  await withFixture({
    plans: (index, { home, accountHome }) => okPlan(index === 0 ? home : accountHome),
  }, async ({ host, resolved }) => {
    await host.startSession({
      sessionId: 'plan-order-owned-resume',
      resumeThreadId: 'thread-owned',
      resumeAccount: 'work',
    })
    assert.deepEqual(resolved, [{ provider: 'codex', preferred: 'work', exact: true }],
      'the resume went through ordinary rotation instead of selecting the thread owner')
  })

  await withFixture({
    plans: (index, { home, accountHome }) => okPlan(index === 0 ? home : accountHome),
  }, async ({ host, resolved }) => {
    await host.startSession({ sessionId: 'plan-order-fresh-account' })
    assert.deepEqual(resolved, [{ provider: 'codex' }],
      'adding resume affinity changed the account policy for a fresh conversation')
  })
})

test('a resume refuses before binding authority when rotation cannot return its exact owner', async () => {
  await withFixture({
    account: { name: 'different-account', resolvedHome: null },
    plans: (_index, { home }) => okPlan(home),
  }, async ({ host, asked, bindings }) => {
    const before = engineCalls().length
    await assert.rejects(host.startSession({
      sessionId: 'plan-order-wrong-resume-account',
      resumeThreadId: 'thread-owned',
      resumeAccount: 'work',
    }), { code: 'AGENT_RESUME_ACCOUNT_UNAVAILABLE' })
    assert.equal(asked.length, 1, 'the wrong account was used to build a pinned plan')
    assert.equal(bindings.length, 0, 'authority was issued for a resume that cannot reach its thread')
    assert.equal(engineCalls().length, before, 'a provider child was started under the wrong account')
  })
})

test('a recorded resume owner refuses when this host has no account selector', async () => {
  await withFixture({
    account: null,
    plans: (_index, { home }) => okPlan(home),
  }, async ({ host, asked, bindings }) => {
    await assert.rejects(host.startSession({
      sessionId: 'plan-order-no-account-selector',
      resumeThreadId: 'thread-owned',
      resumeAccount: 'work',
    }), { code: 'AGENT_RESUME_ACCOUNT_UNAVAILABLE' })
    assert.equal(asked.length, 1)
    assert.equal(bindings.length, 0)
  })
})

/* ---------- the five refusals that do not depend on the account ---------- */
//
// Each is asserted as an EXCEPTION from the call rather than a rejected promise.
// That distinction is the whole ordering property: a previous attempt to move
// the plan into the asynchronous start turned these five throws into rejections,
// and "Missing expected exception" is how it was caught.

test('a level that cannot be confined refuses synchronously, before the account is resolved', async () => {
  await withFixture({
    plans: () => ({ ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE' }),
  }, async ({ host, asked, resolved, bindings }) => {
    const before = engineCalls().length
    assert.throws(() => host.startSession({ sessionId: 'plan-order-unbuildable' }),
      { code: 'AGENT_CONFINEMENT_UNAVAILABLE' },
      'an unbuildable confinement no longer refuses the caller before it holds anything that looks like a running agent')
    assert.equal(asked.length, 1, 'the base plan was not the only plan built for a start that could not be confined')
    assert.equal(resolved.length, 0, 'the account resolver -- a child process -- was asked on a start that was already refused')
    assert.equal(bindings.length, 0, 'a session credential was bound for a start that could not be confined')
    assert.equal(engineCalls().length, before, 'the engine child was started for a refused session')
  })
})

test('tool limits that cannot be read refuse synchronously, and the confinement code still wins when both fail', async () => {
  await withFixture({
    plans: (_index, { home }) => okPlan(home),
    extras: () => ({ ok: false, code: 'AGENT_TOOL_LIMITS_UNREADABLE' }),
  }, async ({ host, resolved }) => {
    assert.throws(() => host.startSession({ sessionId: 'plan-order-limits' }),
      { code: 'AGENT_TOOL_LIMITS_UNREADABLE' })
    assert.equal(resolved.length, 0, 'the account was resolved for a session whose recorded tool limits could not be read')
  })

  // Both broken at once: the confinement refusal is the one that was true before
  // tool limits existed, so it keeps precedence.
  await withFixture({
    plans: () => ({ ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE' }),
    extras: () => ({ ok: false, code: 'AGENT_TOOL_LIMITS_UNREADABLE' }),
  }, async ({ host }) => {
    assert.throws(() => host.startSession({ sessionId: 'plan-order-both' }),
      { code: 'AGENT_CONFINEMENT_UNAVAILABLE' },
      'a start that fails two checks at once no longer reports the one that was true before the other existed')
  })
})

test('a plan that reintroduces a billing credential after the scrub refuses synchronously', async () => {
  await withFixture({
    plans: (_index, { home }) => okPlan(home, { env: { ANTHROPIC_API_KEY: 'sk-ant-fixture-would-bill-a-metered-account' } }),
  }, async ({ host, resolved, bindings }) => {
    assert.throws(() => host.startSession({ sessionId: 'plan-order-billing' }),
      { code: 'LAUNCH_BILLING_CREDENTIAL_PRESENT' },
      'a plan layer that puts a metered credential back after the scrub no longer refuses before the caller holds a handle')
    assert.equal(resolved.length, 0)
    assert.equal(bindings.length, 0)
  })
})

test('a plan whose environment names a foreign profile refuses synchronously', async () => {
  await withFixture({
    plans: (_index, { home }) => okPlan(home, { env: { MC_TEST_FOREIGN_PROFILE_SENTINEL: '1' } }),
  }, async ({ host, resolved }) => {
    assert.throws(() => host.startSession({ sessionId: 'plan-order-foreign' }),
      { code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT' })
    assert.equal(resolved.length, 0)
  })
})

/* ---------- the account's own refusals, all before any credential exists ---------- */

test('an account whose plan cannot be built refuses before a credential is ever bound', async () => {
  await withFixture({
    plans: (index, { home }) => (index === 0
      ? okPlan(home)
      : { ok: false, code: 'AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED' }),
  }, async ({ host, asked, bindings, revocations }) => {
    const before = engineCalls().length
    await assert.rejects(host.startSession({ sessionId: 'plan-order-bad-account' }),
      { code: 'AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED' })
    assert.equal(asked.length, 2,
      'the account-pinned plan was skipped, so the account was never proved plannable before the credential was issued')
    assert.equal(bindings.length, 0,
      'the owner host issued authority for a session whose chosen account could not be confined')
    assert.equal(revocations.length, 0, 'a credential that was never bound was revoked')
    assert.equal(engineCalls().length, before, 'the engine child was started for a refused session')
  })
})

test('an account the resolver reports as blocked refuses before a credential is ever bound', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'blocked-'))
  const bindings = []
  try {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
      enginePath: ENGINE,
      defaultCwd: workdir,
      confinementPlanner: () => okPlan(path.join(workdir, 'agent-home')),
      async accountResolver() {
        return { blocked: true, code: 'AGENT_ACCOUNT_UNAVAILABLE', reason: 'the account that can serve is spent' }
      },
      sessionAuthority: {
        async bind(binding) { bindings.push({ ...binding }); return { bound: true, mode: 'owner-host', credential: ISSUED } },
        async revoke() { return { revoked: true } },
      },
    })
    await assert.rejects(host.startSession({ sessionId: 'plan-order-blocked' }), { code: 'AGENT_ACCOUNT_UNAVAILABLE' })
    assert.equal(bindings.length, 0, 'a credential was bound for a session the person had asked to stop and switch')
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a credential-bound plan that cannot be built refuses and the issued credential is revoked', async () => {
  await withFixture({
    plans: (index, { home, accountHome }) => (index === 2
      ? { ok: false, code: 'AGENT_CONFINEMENT_HOME_UNAVAILABLE' }
      : okPlan(index === 0 ? home : accountHome)),
  }, async ({ host, bindings, revocations }) => {
    const before = engineCalls().length
    await assert.rejects(host.startSession({ sessionId: 'plan-order-credential' }),
      { code: 'AGENT_CONFINEMENT_HOME_UNAVAILABLE' })
    assert.equal(bindings.length, 1)
    assert.equal(revocations.length, 1,
      'a credential the owner host had issued was left standing for a session that never started')
    assert.equal(engineCalls().length, before, 'the engine child was started for a refused session')
  })
})

/* ---------- one launch environment per distinct plan layer ---------- */

test('a start whose three plans carry the same environment builds one launch environment', async () => {
  await withFixture({
    plans: (_index, { home }) => okPlan(home),
  }, async ({ host, asked, home }) => {
    const beforeBuilds = launchBuilds()
    const beforeCalls = engineCalls().length
    await host.startSession({ sessionId: 'plan-order-one-env' })

    assert.equal(asked.length, 3, 'the three plans this measurement is about were not all built')
    assert.equal(launchBuilds() - beforeBuilds, 1,
      'the launch environment was rebuilt for a plan layer identical to the one already asserted -- MEASURED 2026-09-03 at 5.0-7.3 ms per build')
    assert.equal(engineCalls()[beforeCalls].env.CODEX_HOME, home,
      'the child was launched with something other than the environment its plan decided')
  })
})

test('a plan layer that changes is built again and asserted again', async () => {
  // The pinned plan moves CODEX_HOME, so the environment MUST be rebuilt; the
  // credential-bound plan keeps the pinned layer, so it must not be.
  await withFixture({
    plans: (index, { home, accountHome }) => okPlan(index === 0 ? home : accountHome),
  }, async ({ host, accountHome }) => {
    const beforeBuilds = launchBuilds()
    const beforeCalls = engineCalls().length
    await host.startSession({ sessionId: 'plan-order-changed-env' })
    assert.equal(launchBuilds() - beforeBuilds, 2,
      'a plan layer that moved the confined home was not rebuilt, or an unchanged one was')
    assert.equal(engineCalls()[beforeCalls].env.CODEX_HOME, accountHome,
      'the child inherited the pre-account home, so the account pin never reached it')
  })

  // The fence and the billing tripwire run on the CHANGED layer, not only on the
  // first one. Driven from the account-pinned plan, which is the layer a reuse
  // would be tempted to take for granted.
  await withFixture({
    plans: (index, { home, accountHome }) => (index === 0
      ? okPlan(home)
      : okPlan(accountHome, { env: { MC_TEST_FOREIGN_PROFILE_SENTINEL: '1' } })),
  }, async ({ host, bindings }) => {
    await assert.rejects(host.startSession({ sessionId: 'plan-order-changed-foreign' }),
      { code: 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT' },
      'the account-pinned environment reached the child without passing the foreign-profile fence')
    assert.equal(bindings.length, 0, 'a credential was bound for a session whose pinned environment named a foreign profile')
  })

  await withFixture({
    plans: (index, { home, accountHome }) => (index === 2
      ? okPlan(accountHome, { env: { ANTHROPIC_API_KEY: 'sk-ant-fixture-would-bill-a-metered-account' } })
      : okPlan(index === 0 ? home : accountHome)),
  }, async ({ host, revocations }) => {
    await assert.rejects(host.startSession({ sessionId: 'plan-order-changed-billing' }),
      { code: 'LAUNCH_BILLING_CREDENTIAL_PRESENT' },
      'the credential-bound environment reached the child without passing the billing tripwire')
    assert.equal(revocations.length, 1, 'the issued credential was left standing after the launch environment was refused')
  })
})
