/* THE LOCAL TIER OPENS ON THE ENGINE BEING THERE, AND ON NOTHING ELSE.
 *
 * shell/agent-host.cjs resolveStartTier() opens a non-Codex tier only when a
 * real require() of the payload's engine module succeeds -- loadClaudeEngine()
 * for the three Claude rows, and now loadLocalEngine() for `local`. This
 * suite proves both directions against the SAME host the product constructs:
 *
 *   - a payload with no src/lib/agent-engine/local-node-process.js keeps
 *     refusing `local` by name (AGENT_TIER_NO_LAUNCHER) and keeps it out of
 *     startableTiers(), exactly as every build before the module existed;
 *   - a payload that carries the module opens the tier, lists it, and a start
 *     on it reaches that module's startLocalSession() with the tier's model,
 *     the confinement plan that names the generated tool document (the
 *     engine starts those servers itself), and none of the Codex/Claude-only
 *     arguments (no app-server argv, no command, no configDir); a resume
 *     reaches resumeLocalSession() with the thread to continue and the same
 *     plan.
 *
 * The engine root is the checked-in confined-engine fixture copied into a
 * scratch directory, with the local module added to one copy and not the
 * other, so the only variable between the two hosts is the file the gate
 * requires. No runtime, no model and no process is involved: the fixture's
 * startLocalSession() records what it was handed and starts nothing.
 *
 * Run alone with:
 *   node --test tools/test/agent-host-local-tier.test.mjs
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAgentHost, confinementPlanFor } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))
const FIXTURE_ENGINE = path.join(ROOT, 'tools', 'test', 'fixtures', 'confined-engine')
const LOCAL_MODULE = path.join('src', 'lib', 'agent-engine', 'local-node-process.js')
const CODEX_MODULE = path.join('src', 'lib', 'agent-engine', 'codex-process.js')

/* Scratch under the running account's own profile temp, never under
   node_modules: on a worktree that directory is a junction into another
   checkout, and a recursive delete through it is how a shared dependency tree
   was emptied on 2026-09-04. */
function scratchRoot() {
  const home = os.homedir()
  const profileTemp = process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'Temp') : os.tmpdir()
  const root = existsSync(profileTemp) ? profileTemp : os.tmpdir()
  return mkdtempSync(path.join(root, 'toolsenabled-local-tier-'))
}

const SCRATCH = scratchRoot()
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

/* One engine root per case, copied from the fixture. `withLocalModule` adds a
   recording local engine; without it the copy is exactly the fixture. */
function stageEngine(name, { withLocalModule }) {
  const root = path.join(SCRATCH, name)
  cpSync(FIXTURE_ENGINE, root, { recursive: true })
  if (withLocalModule) {
    mkdirSync(path.dirname(path.join(root, LOCAL_MODULE)), { recursive: true })
    writeFileSync(path.join(root, LOCAL_MODULE), `'use strict'
// Records what the agent host handed the local engine. Starts nothing.
const calls = []
function adapter() {
  return {
    sendTurn: async () => ({ turnId: 't1' }),
    interrupt: async () => {},
    answerApproval: async () => {},
    forkThread: async () => ({ threadId: 'local-forked' }),
  }
}
async function startLocalSession(options) {
  calls.push({ resumed: false, ...options })
  return { adapter: adapter(), threadId: 'local-thread-1', model: 'fake-model:1b', runtime: 'ollama', endpoint: 'http://127.0.0.1:1', close() {} }
}
async function resumeLocalSession(options) {
  calls.push({ resumed: true, ...options })
  return { adapter: adapter(), threadId: options.threadId, model: 'fake-model:1b', runtime: 'ollama', endpoint: 'http://127.0.0.1:1', turns: [], turnCount: 0, threadCwd: null, close() {} }
}
module.exports = { calls, startLocalSession, resumeLocalSession }
`)
    /* The copy's planner also builds the account-free Local tool plan,
       staged by the test so the mcpConfig it names is the one the host must
       hand the local engine. Appended to the COPY only; the checked-in fixture
       keeps deliberately lacking the export. */
    const planner = path.join(root, 'src', 'lib', 'agent-session-confinement.js')
    writeFileSync(planner, `${readFileSync(planner, 'utf8')}
module.exports.localSessionPlan = () => JSON.parse(process.env.MC_TEST_LOCAL_TOOLS_PLAN || '{"ok":false,"code":"AGENT_CONFINEMENT_UNAVAILABLE"}')
`)
  }
  const workdir = path.join(root, 'work')
  mkdirSync(workdir, { recursive: true })
  return { root, workdir, enginePath: path.join(root, CODEX_MODULE) }
}

/* A realistic recorded level for the fixture planner, so the thread options
   the host spreads onto the start are the strings a real planner produces;
   and, for a copy that carries localSessionPlan, the tool plan it
   answers with -- the shape the real planner's tool plan has, naming a
   generated document by full path. */
function withResolvedLevel(run, { toolPlan = null } = {}) {
  const previous = process.env.MC_TEST_CONFINEMENT_RESOLVED
  const previousToolPlan = process.env.MC_TEST_LOCAL_TOOLS_PLAN
  process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true, sandbox: 'read-only', approvalPolicy: 'never' })
  if (toolPlan) process.env.MC_TEST_LOCAL_TOOLS_PLAN = JSON.stringify(toolPlan)
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_RESOLVED
    else process.env.MC_TEST_CONFINEMENT_RESOLVED = previous
    if (previousToolPlan === undefined) delete process.env.MC_TEST_LOCAL_TOOLS_PLAN
    else process.env.MC_TEST_LOCAL_TOOLS_PLAN = previousToolPlan
  })
}

function toolPlanFor(engine) {
  return {
    ok: true, tier: 'guided', isolated: true, failedClosed: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: null,
    mcpConfig: path.join(engine.root, 'generated', '.mcp.json'),
    servers: ['toolsenabled'],
    account: null,
  }
}

test('Local refuses an older planner instead of selecting a provider credential surface', () => {
  const legacy = {
    confinedSessionPlan: () => assert.fail('Local must not enter the Codex planner'),
    claudeToolsSessionPlan: () => assert.fail('Local must not enter the Claude planner'),
  }
  assert.deepEqual(confinementPlanFor(legacy, { provider: 'local' }), { ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE' })
})

/* startSession() refuses a tier synchronously, before it holds anything a
   caller could mistake for a running agent; a later refusal is a rejection.
   Either shape is caught here so the assertion is about the CODE. */
async function startOutcome(host, request) {
  try {
    return { value: await host.startSession(request) }
  } catch (error) {
    return { error }
  }
}

test('a payload without the local engine module keeps refusing the local tier by name and keeps it out of the startable list', async () => {
  const engine = stageEngine('without-local', { withLocalModule: false })
  const host = createAgentHost({ enginePath: engine.enginePath, defaultCwd: engine.workdir })
  try {
    const tiers = host.startableTiers().tiers
    assert.ok(tiers.includes('luna'), 'the Codex tiers are still startable')
    assert.equal(tiers.includes('local'), false, 'local must not be offered as startable when nothing can start it')
    const outcome = await withResolvedLevel(() => startOutcome(host, { sessionId: 'local-refused', tier: 'local', acknowledgeLowMemory: true }))
    assert.ok(outcome.error, 'the start must be refused')
    assert.equal(outcome.error.code, 'AGENT_TIER_NO_LAUNCHER')
    assert.match(outcome.error.message, /local tier runs on local/, 'the refusal names the tier and its provider')
    assert.doesNotMatch(outcome.error.message, /Startable tiers:.*\blocal\b/, 'the refusal does not list local among the startable tiers')
  } finally {
    await host.closeAll()
  }
})

test('a payload carrying the local engine module opens the tier, and a start reaches startLocalSession with the tier model and no Codex or Claude argv', async () => {
  const engine = stageEngine('with-local', { withLocalModule: true })
  const host = createAgentHost({ enginePath: engine.enginePath, defaultCwd: engine.workdir })
  const localEngine = require_(path.join(engine.root, LOCAL_MODULE))
  try {
    const tiers = host.startableTiers().tiers
    assert.ok(tiers.includes('local'), `local must be startable when the engine module loads (got ${tiers.join(', ')})`)
    assert.ok(tiers.includes('luna') && tiers.includes('terra') && tiers.includes('sol'), 'the Codex tiers are untouched')

    const toolPlan = toolPlanFor(engine)
    const started = await withResolvedLevel(() => host.startSession({ sessionId: 'local-1', tier: 'local', acknowledgeLowMemory: true }), { toolPlan })
    assert.equal(started.sessionId, 'local-1')
    assert.equal(started.threadId, 'local-thread-1', 'the thread the local engine minted is the session\'s thread')
    assert.equal(started.tier, 'guided', 'the level the tool plan recorded is the level the session reports')

    assert.equal(localEngine.calls.length, 1, 'exactly one local start reached the engine')
    const call = localEngine.calls[0]
    assert.equal(call.resumed, false)
    assert.equal(call.threadOptions.model, 'local/auto', 'the tier\'s model reaches the engine as the thread option')
    assert.equal(call.threadOptions.sandbox, 'read-only', 'the recorded level still binds the thread')
    assert.equal(call.threadOptions.approvalPolicy, 'never')
    assert.equal(typeof call.onEvent, 'function', 'the engine is handed the event sink')
    assert.equal(typeof call.cwd, 'string')
    assert.equal('args' in call, false, 'the Codex app-server argv must not be handed to a local engine')
    assert.equal('command' in call, false, 'the Claude program path must not be handed to a local engine')
    assert.equal('configDir' in call, false, 'no sign-in directory is handed to a local engine')
    assert.ok(call.env && typeof call.env === 'object', 'the scrubbed launch environment is still computed and passed, as for every engine')
    /* THE TOOL SURFACE TRAVELS AS THE PLAN, whole, exactly as it does for
       Claude: the engine reads mcpConfig off it and starts those servers. */
    assert.ok(call.plan && typeof call.plan === 'object', 'the confinement plan that names the tool document is handed to the local engine')
    assert.equal(call.plan.mcpConfig, toolPlan.mcpConfig, 'the plan names the generated tool document by full path')
    assert.deepEqual(call.plan.servers, ['toolsenabled'])

    const resumed = await withResolvedLevel(() => host.startSession({
      sessionId: 'local-2', tier: 'local', resumeThreadId: 'local-thread-1', acknowledgeLowMemory: true,
    }), { toolPlan })
    assert.equal(resumed.threadId, 'local-thread-1')
    assert.equal(localEngine.calls.length, 2)
    assert.equal(localEngine.calls[1].resumed, true, 'a resume on the local tier reaches resumeLocalSession')
    assert.equal(localEngine.calls[1].threadId, 'local-thread-1')
    assert.equal(localEngine.calls[1].plan.mcpConfig, toolPlan.mcpConfig, 'a resumed conversation keeps its tool surface')
  } finally {
    await host.closeAll()
  }
})

test('a Codex tier on the same payload never reaches the local engine', async () => {
  const engine = stageEngine('with-local-codex', { withLocalModule: true })
  const host = createAgentHost({ enginePath: engine.enginePath, defaultCwd: engine.workdir })
  const localEngine = require_(path.join(engine.root, LOCAL_MODULE))
  const codexEngine = require_(engine.enginePath)
  try {
    const before = codexEngine.calls.length
    const previous = process.env.MC_TEST_CONFINEMENT_PLAN
    process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
      ok: true, tier: 'guided', isolated: true,
      threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(engine.workdir, 'agent-home') },
    })
    try {
      await host.startSession({ sessionId: 'codex-1', tier: 'luna', acknowledgeLowMemory: true })
    } finally {
      if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
      else process.env.MC_TEST_CONFINEMENT_PLAN = previous
    }
    assert.equal(codexEngine.calls.length, before + 1, 'the Codex start reached the Codex engine')
    assert.equal(localEngine.calls.length, 0, 'and never the local one')
  } finally {
    await host.closeAll()
  }
})

test('the real shared planner starts and resumes Local in a private profile without consulting subscription accounts, for every tool mode', async () => {
  // Use the explicitly selected source during source qualification, or the
  // shipped payload when testing an installed artifact. No live state is read.
  const source = canonicalRootForTests({ requireConfigured: true })
  const policy = require_(path.join(source, 'src/lib/provider-session-isolation.js'))
  const actualPlanner = require_(path.join(source, 'src/lib/agent-session-confinement.js'))
  const machineRecord = require_(path.join(source, 'src/lib/setup/machine-record.js'))
  const privateRoot = path.join(SCRATCH, 'actual-private-profile')
  mkdirSync(privateRoot, { mode: 0o700 })
  const context = policy.isolationContext({ ...process.env, TOOLSENABLED_PROVIDER_ISOLATION_ROOT: privateRoot,
    TOOLSENABLED_STATE_ROOT: path.join(privateRoot, 'state', 'capability') })
  const pinned = policy.profileEnvironment(context)
  const keys = [...Object.keys(pinned), 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME']
  const previous = keys.map(key => [key, process.env[key]])
  Object.assign(process.env, pinned)
  for (const key of keys.slice(Object.keys(pinned).length)) delete process.env[key]
  try {
    const workspace = path.join(privateRoot, 'workspace')
    mkdirSync(workspace)
    const record = machineRecord.buildMachineRecord({ tier: 'unrestricted', installRoot: source,
      servicesRoot: context.servicesRoot, nodePath: process.execPath, workspaceRoots: [workspace] })
    machineRecord.writeMachineRecord(record, { servicesRoot: context.servicesRoot })
    for (const agentApiMode of ['Only', 'Enabled', 'Disabled']) {
      const engine = stageEngine(`real-plan-${agentApiMode}`, { withLocalModule: true })
      const bindings = []
      const host = createAgentHost({ enginePath: engine.enginePath, defaultCwd: workspace,
        freeMemory: () => 64 * 1024 ** 3,
        confinementPlanner: options => confinementPlanFor(actualPlanner, { ...options, agentApiMode }),
        accountResolver: async () => assert.fail('Local must never inspect or rotate a subscription account'),
        sessionAuthority: { toolModeVersion: 1, scopeVersion: 1, actorsVersion: 1, agentActors: ['local'],
          bind: async (...args) => { bindings.push(args); return { bound: true, credential: 'A'.repeat(43) } }, revoke: async () => {} },
      })
      const localEngine = require_(path.join(engine.root, LOCAL_MODULE))
      try {
        for (const resumed of [false, true]) {
          await host.startSession({ sessionId: `real-local-${agentApiMode.toLowerCase()}-${resumed}`, tier: 'local', agentId: 'local-worker',
            role: { id: 'worker', name: 'Worker', owns: 'Inspect the fixture.', mustNot: 'Change user files.', handoff: 'Return evidence.' },
            agentAuthority: { agentId: 'local-worker', provider: 'local', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 },
            ...(resumed ? { resumeThreadId: 'local-thread-1' } : {}), acknowledgeLowMemory: true })
          const call = localEngine.calls.at(-1)
          assert.equal(call.resumed, resumed)
          assert.equal(call.plan.account, null)
          assert.equal(call.plan.agentApiMode, agentApiMode)
          assert.equal(call.env.HOME, context.userProfile)
          for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME']) assert.equal(Object.hasOwn(call.env, key), false, key)
          for (const key of ['configDir', 'settings', 'codexHome', 'claudePermissionMode']) assert.equal(Object.hasOwn(call.plan, key), false, key)
          const servers = JSON.parse(readFileSync(call.plan.mcpConfig, 'utf8')).mcpServers
          if (agentApiMode === 'Disabled') assert.deepEqual(servers, {})
          else {
            const owned = Object.values(servers).filter(server => server.env?.TOOLSENABLED_AGENT_ACTOR)
            assert.ok(owned.length > 0)
            for (const server of owned) {
              assert.equal(server.env.TOOLSENABLED_AGENT_ACTOR, 'local')
              assert.equal(server.env.TOOLSENABLED_AGENT_ID, 'local-worker')
              assert.equal(server.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, 'A'.repeat(43))
            }
          }
        }
        assert.equal(bindings.length, 2, 'both starts retain owner-host session identity binding')
      } finally { await host.closeAll() }
    }
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
