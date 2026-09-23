import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const hostFs = require('node:fs')
const hostModule = require('node:module')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { createAgentCommandSurface } = require('../../shell/agent-command-surface.cjs')
const { createAgentHost } = require(path.join(root, 'shell/agent-host.cjs'))
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')

const windowPrincipal = Object.freeze({ kind: 'window', owner: Object.freeze({ id: 'outcome-window' }), mayWrite: true, label: 'outcome fixture' })
const admitted = Object.freeze({ requestSessionId: 'start-1', admission: 'admitted', cleanup: 'not-required', custody: 'session' })
const localModuleSuffix = '/src/lib/agent-engine/local-node-process.js'

async function withLocalEngineModule(action) {
  const originalExistsSync = hostFs.existsSync
  const originalLoad = hostModule._load
  hostFs.existsSync = candidate => {
    const normalized = String(candidate).replaceAll('\\', '/')
    return normalized.endsWith(localModuleSuffix) || originalExistsSync(candidate)
  }
  hostModule._load = function load(request, parent, isMain) {
    const normalized = String(request).replaceAll('\\', '/')
    if (normalized.endsWith(localModuleSuffix)) {
      return { startLocalSession: async () => { throw new Error('local engine must not be dispatched by this control') } }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return await action()
  } finally {
    hostFs.existsSync = originalExistsSync
    hostModule._load = originalLoad
  }
}

function buildDeps(startSession) {
  const agentSessions = new Map()
  const host = { startSession }
  const noOp = () => {}
  const identity = value => value
  const deps = {
    agentSessions,
    currentAgentHost: () => host,
    getAgentHost: () => host,
    agentIpcError(code, message) {
      const error = new Error(message)
      error.code = code
      throw error
    },
    agentPayload: identity,
    boundedAgentString: value => value,
    parseAgentStart: value => ({ sessionId: value.sessionId || 'generated-start' }),
    parseAgentSend: identity,
    parseAgentSessionCommand: identity,
    rendererSafeAgentError(error) {
      const safe = new Error(typeof error?.code === 'string' ? error.code : 'AGENT_SESSION_FAILED')
      safe.code = typeof error?.code === 'string' ? error.code : 'AGENT_SESSION_FAILED'
      if (error?.exhaustedBy === 'provider' || error?.exhaustedBy === 'configured') {
        safe.exhaustedBy = error.exhaustedBy
      }
      return safe
    },
    spawnRecordAvailability: () => ({ ok: true }),
    spawnRecordHistory: () => ({ ok: true, entries: [] }),
    usageRecordHistory: () => ({ ok: true, entries: [] }),
    engineAvailability: () => ({ ok: true }),
    ensureWorkspaceRoot: () => 'C:\\outcome-workspace',
    chosenWorkspaceCwd: () => null,
    readAgentConfinement: () => ({ ok: true }),
    listAgentTools: () => ({ ok: true, tools: [] }),
    resolveCapabilityRoot: () => null,
    requireModule: () => ({}),
    readStandingRequests: () => ({ ok: true, entries: [] }),
    readCanonicalLedger: () => ({ ok: true, records: [] }),
    sessionProfiles: {},
    recordSpawnIntent: () => ({ sequence: 1, eventHash: 'outcome-event' }),
    recordSpawnOutcome: noOp,
    recordSessionEnd: noOp,
    bindAgentOwner: noOp,
    agentOrgRecord: { read: () => ({ ok: true, org: {}, roles: [] }) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    MAX_SESSION_ID_LENGTH: 128,
    AGENT_EFFORT_VALUES: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    WORKSPACE_ROOT: 'C:\\outcome-workspace',
  }
  return { deps, agentSessions }
}

test('a successful native start carries the admitted request-bound outcome through the command surface', async () => {
  const { deps } = buildDeps(async request => ({ sessionId: request.sessionId, threadId: 'native-thread', startOutcome: admitted }))
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'start-1' }, windowPrincipal)

  assert.equal(result.ok, undefined)
  assert.deepEqual(result.startOutcome, admitted)
  assert.equal(deps.agentSessions.get('start-1').state, 'ready')
})

test('a pre-dispatch refusal is explicit no-admission and does not authorize a second start by error code', async () => {
  const outcome = Object.freeze({ requestSessionId: 'start-2', admission: 'not-admitted', cleanup: 'not-required', custody: 'none' })
  const { deps } = buildDeps(async request => {
    throw Object.assign(new Error('provider refusal'), { code: 'PROVIDER_NOT_READY', startOutcome: outcome })
  })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'start-2' }, windowPrincipal)

  assert.equal(result.ok, false)
  assert.deepEqual(result.startOutcome, outcome)
  assert.equal(result.sessionId, 'start-2')
  assert.equal(deps.agentSessions.has('start-2'), false)
})

test('structured start refusals preserve bounded provider-limit attribution only', async () => {
  const outcome = Object.freeze({ requestSessionId: 'attribution', admission: 'not-admitted', cleanup: 'not-required', custody: 'none' })
  for (const exhaustedBy of ['provider', 'configured', 'unknown']) {
    const { deps } = buildDeps(async () => {
      throw Object.assign(new Error('account limit'), {
        code: 'AGENT_ACCOUNT_EXHAUSTED', exhaustedBy, startOutcome: outcome,
      })
    })
    const surface = createAgentCommandSurface(deps)
    const result = await surface.run('agent:start', { sessionId: 'attribution' }, windowPrincipal)
    assert.equal(result.ok, false)
    assert.deepEqual(result.startOutcome, outcome)
    assert.equal(result.exhaustedBy, exhaustedBy === 'unknown' ? undefined : exhaustedBy, exhaustedBy)
  }
})

test('a post-dispatch rejection with completed cleanup is admission-unknown but safely released', async () => {
  const outcome = Object.freeze({ requestSessionId: 'start-3', admission: 'unknown', cleanup: 'confirmed', custody: 'none' })
  const { deps } = buildDeps(async () => {
    throw Object.assign(new Error('malformed engine reply'), { code: 'AGENT_ENGINE_INVALID_SESSION', startOutcome: outcome })
  })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'start-3' }, windowPrincipal)

  assert.equal(result.ok, false)
  assert.deepEqual(result.startOutcome, outcome)
  assert.equal(result.cleanupPending, undefined)
  assert.equal(deps.agentSessions.has('start-3'), false)
})

test('cleanup-pending retains owner custody even when the provider error code is not the legacy cleanup code', async () => {
  const outcome = Object.freeze({ requestSessionId: 'start-4', admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending' })
  const { deps } = buildDeps(async () => {
    throw Object.assign(new Error('governor release failed'), { code: 'RESOURCE_LEASE_RELEASE_FAILED', startOutcome: outcome })
  })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'start-4' }, windowPrincipal)

  assert.equal(result.ok, false)
  assert.deepEqual(result.startOutcome, outcome)
  assert.equal(result.cleanupPending, true)
  assert.equal(deps.agentSessions.get('start-4').state, 'close-failed')
})

test('without a trusted outcome the surface retains uncertain custody after host invocation', async () => {
  const { deps } = buildDeps(async () => {
    throw Object.assign(new Error('provider refusal'), { code: 'PROVIDER_NOT_READY' })
  })
  const surface = createAgentCommandSurface(deps)

  await assert.rejects(surface.run('agent:start', { sessionId: 'start-5' }, windowPrincipal), { code: 'PROVIDER_NOT_READY' })
  assert.equal(deps.agentSessions.get('start-5').state, 'close-failed')
})

test('a cancelled start keeps its request-bound cleanup outcome instead of becoming a code-only retry hint', async () => {
  const outcome = Object.freeze({ requestSessionId: 'start-6', admission: 'unknown', cleanup: 'confirmed', custody: 'none' })
  const { deps } = buildDeps(async () => {
    throw Object.assign(new Error('startup cancelled'), { code: 'AGENT_SESSION_START_CANCELLED', startOutcome: outcome })
  })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'start-6' }, windowPrincipal)

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_SESSION_START_CANCELLED')
  assert.deepEqual(result.startOutcome, outcome)
  assert.equal(deps.agentSessions.has('start-6'), false)
})

test('same-id released-custody contradictions retain the outer owner record', async () => {
  const outcomes = [
    { admission: 'unknown', cleanup: 'pending', custody: 'none' },
    { admission: 'unknown', cleanup: 'not-required', custody: 'none' },
    { admission: 'admitted', cleanup: 'confirmed', custody: 'none' },
  ]
  for (const [index, tuple] of outcomes.entries()) {
    const sessionId = `start-7-${index}`
    const outcome = Object.freeze({ requestSessionId: sessionId, ...tuple })
    const { deps } = buildDeps(async () => {
      throw Object.assign(new Error('malformed outcome'), { code: 'AGENT_ENGINE_INVALID_SESSION', startOutcome: outcome })
    })
    const surface = createAgentCommandSurface(deps)

    await assert.rejects(surface.run('agent:start', { sessionId }, windowPrincipal), {
      code: 'AGENT_ENGINE_INVALID_SESSION',
    })
    assert.equal(deps.agentSessions.get(sessionId).state, 'close-failed', JSON.stringify(tuple))
  }
})

test('a trusted no-custody refusal cannot delete a rebound session record', async () => {
  let rebound
  const { deps } = buildDeps(async request => {
    rebound = { state: 'ready', rebound: true }
    deps.agentSessions.set(request.sessionId, rebound)
    throw Object.assign(new Error('completed cleanup'), {
      code: 'AGENT_ENGINE_INVALID_SESSION',
      startOutcome: Object.freeze({
        requestSessionId: request.sessionId, admission: 'unknown', cleanup: 'confirmed', custody: 'none',
      }),
    })
  })
  const surface = createAgentCommandSurface(deps)
  const result = await surface.run('agent:start', { sessionId: 'rebound-1' }, windowPrincipal)

  assert.equal(result.ok, false)
  assert.strictEqual(deps.agentSessions.get('rebound-1'), rebound)
})
test('wrong-id, frozen, and primitive host failures retain custody after invocation', async () => {
  const cases = [
    { label: 'wrong request id', code: 'AGENT_ENGINE_INVALID_SESSION', error: () => {
      const error = new Error('mismatched outcome')
      error.code = 'AGENT_ENGINE_INVALID_SESSION'
      Object.defineProperty(error, 'startOutcome', {
        value: Object.freeze({ requestSessionId: 'other-start', admission: 'unknown', cleanup: 'confirmed', custody: 'none' }),
        configurable: false, enumerable: true,
      })
      return error
    } },
    { label: 'frozen release error', code: 'RESOURCE_LEASE_RELEASE_FAILED', error: () => {
      const error = Object.assign(new Error('frozen release'), { code: 'RESOURCE_LEASE_RELEASE_FAILED' })
      return Object.freeze(error)
    } },
    { label: 'primitive engine error', code: 'AGENT_SESSION_FAILED', error: () => 'opaque engine reply' },
  ]
  for (const [index, entry] of cases.entries()) {
    const sessionId = `opaque-${index}`
    const { deps } = buildDeps(async () => { throw entry.error() })
    const surface = createAgentCommandSurface(deps)
    await assert.rejects(surface.run('agent:start', { sessionId }, windowPrincipal), error => {
      assert.equal(error.code, entry.code, entry.label)
      return true
    })
    assert.equal(deps.agentSessions.get(sessionId).state, 'close-failed', entry.label)
  }
})

test('the real createAgentHost early tier refusal is request-bound no-admission', async () => {
  const sessionId = 'real-early-refusal'
  const host = createAgentHost({ enginePath, defaultCwd: root, freeMemory: () => 64 * 1024 ** 3 })
  try {
    assert.throws(() => host.startSession({ sessionId, tier: 'not-a-real-tier' }), error => {
      assert.equal(error.code, 'AGENT_TIER_UNKNOWN')
      assert.deepEqual(error.startOutcome, {
        requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none',
      })
      return true
    })
    assert.equal(host.sessionActivity(sessionId), null)
  } finally {
    await host.closeAll()
  }
})
test('an unowned finalizer rejection retains the pre-dispatch custody hold', async () => {
  const sessionId = 'finalizer-custody-hold'
  let cleanupAttempts = 0
  const cleanupUnproven = Object.assign(new Error('provider cleanup unproven'), {
    code: 'CODEX_START_CLEANUP_UNPROVEN',
    retryCleanup() {
      if (cleanupAttempts++ === 0) throw Object.assign(new Error('cleanup still pending'), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
    },
  })
  const finalizerError = Object.assign(new Error('start finalizer failed'), { code: 'START_FINALIZER_FAILED' })
  let assertions = 0
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  const startAdmission = {
    assertCurrent() {
      if (++assertions > 1) throw cleanupUnproven
    },
    signal: {
      aborted: false,
      addEventListener() {},
      removeEventListener() { throw finalizerError },
    },
  }
  try {
    await assert.rejects(host.startSession({ sessionId, startAdmission }), error => {
      assert.equal(error.code, 'AGENT_SESSION_CLEANUP_FAILED')
      assert.notEqual(error.code, finalizerError.code)
      assert.deepEqual(error.startOutcome, {
        requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'pending', custody: 'cleanup-pending',
      })
      return true
    })
    assert.notEqual(host.sessionActivity(sessionId), null)
  } finally {
    await host.closeAll()
  }
})

test('a synchronous setup failure after registration retains pending host custody', async () => {
  const sessionId = 'late-setup-failure'
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  const setupError = Object.assign(new Error('start listener setup failed'), { code: 'START_LISTENER_SETUP_FAILED' })
  const startAdmission = {
    assertCurrent() {},
    signal: {
      aborted: false,
      addEventListener() { throw setupError },
    },
  }
  try {
    assert.throws(() => host.startSession({ sessionId, startAdmission }), error => {
      assert.equal(error.code, setupError.code)
      assert.deepEqual(error.startOutcome, {
        requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'pending', custody: 'cleanup-pending',
      })
      return true
    })
    assert.notEqual(host.sessionActivity(sessionId), null)
  } finally {
    await host.closeAll()
  }
})
test('a reservation acquired before registration remains held on setup failure', async () => {
  const sessionId = 'reservation-before-registration'
  const token = Object.freeze({ reservation: sessionId })
  const setupError = Object.assign(new Error('resource state setup failed'), { code: 'RESOURCE_STATE_SETUP_FAILED' })
  let reads = 0
  let releases = 0
  const resourceGovernor = {
    reserve() {
      return {
        ok: true,
        token,
        get state() {
          if (reads++ === 0) throw setupError
          return { mode: 'unrestricted', configuredMode: 'unrestricted', measuredAt: Date.now(), bootstrapController: false }
        },
      }
    },
    release(releasedToken, releasedSessionId) {
      assert.strictEqual(releasedToken, token)
      assert.equal(releasedSessionId, sessionId)
      releases += 1
    },
    revalidate() { return { ok: true } },
    ready() {},
  }
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    resourceGovernor,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  assert.throws(() => host.startSession({ sessionId }), error => {
    assert.equal(error.code, setupError.code)
    assert.deepEqual(error.startOutcome, {
      requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'pending', custody: 'cleanup-pending',
    })
    return true
  })
  assert.notEqual(host.sessionActivity(sessionId), null)
  assert.deepEqual(await host.closeSession({ sessionId }), { sessionId, closed: true })
  assert.equal(host.sessionActivity(sessionId), null)
  await host.closeAll()
  assert.equal(releases, 1)
})

test('closeAll positively releases a reservation-backed pre-dispatch record', async () => {
  const sessionId = 'reservation-close-all'
  const token = Object.freeze({ reservation: sessionId })
  const setupError = Object.assign(new Error('resource state setup failed'), { code: 'RESOURCE_STATE_SETUP_FAILED' })
  let reads = 0
  let releases = 0
  const resourceGovernor = {
    reserve() {
      return {
        ok: true,
        token,
        get state() {
          if (reads++ === 0) throw setupError
          return { mode: 'unrestricted', configuredMode: 'unrestricted', measuredAt: Date.now(), bootstrapController: false }
        },
      }
    },
    release(releasedToken, releasedSessionId) {
      assert.strictEqual(releasedToken, token)
      assert.equal(releasedSessionId, sessionId)
      releases += 1
    },
    revalidate() { return { ok: true } },
    ready() {},
  }
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    resourceGovernor,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  assert.throws(() => host.startSession({ sessionId }), error => {
    assert.equal(error.code, setupError.code)
    assert.deepEqual(error.startOutcome, {
      requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'pending', custody: 'cleanup-pending',
    })
    return true
  })
  assert.notEqual(host.sessionActivity(sessionId), null)
  await host.closeAll()
  assert.equal(releases, 1)
  assert.equal(host.sessionActivity(sessionId), null)
})

test('createAgentHost owns the outcome carrier for frozen, primitive, and conflicting pre-dispatch errors', async () => {
  const cases = [
    { label: 'frozen engine error', code: 'ENGINE_SETUP_FAILED', retry: { provider: 'codex', account: 'retry-account', attempts: [] }, make: () => {
      const error = Object.assign(new Error('frozen setup'), { code: 'ENGINE_SETUP_FAILED' })
      Object.defineProperty(error, 'accountRetry', {
        value: { provider: 'codex', account: 'retry-account', attempts: [] },
        enumerable: true, configurable: false, writable: false,
      })
      return Object.freeze(error)
    } },
    { label: 'primitive engine error', code: 'AGENT_START_FAILED', make: () => 'primitive setup failure' },
    { label: 'conflicting upstream outcome', code: 'ENGINE_SETUP_FAILED', make: () => {
      const error = Object.assign(new Error('conflicting setup'), { code: 'ENGINE_SETUP_FAILED' })
      Object.defineProperty(error, 'startOutcome', {
        value: Object.freeze({ requestSessionId: 'other', admission: 'unknown', cleanup: 'confirmed', custody: 'none' }),
        configurable: false, enumerable: true,
      })
      return error
    } },
  ]
  for (const [index, entry] of cases.entries()) {
    const sessionId = `carrier-${index}`
    let upstream
    const host = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => { upstream = entry.make(); throw upstream },
    })
    try {
      assert.throws(() => host.startSession({ sessionId }), error => {
        assert.equal(error.code, entry.code, entry.label)
        assert.deepEqual(error.startOutcome, {
          requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none',
        }, entry.label)
        assert.strictEqual(error.cause, upstream, entry.label)
        if (entry.retry) assert.deepEqual(error.accountRetry, entry.retry, entry.label)
        return true
      })
    } finally {
      await host.closeAll()
    }
  }
})
test('the host carrier preserves accountRetry on a frozen final startup error', async t => {
  const engine = require(enginePath)
  const upstream = Object.freeze(Object.assign(new Error('frozen provider startup'), { code: 'ENGINE_START_FROZEN' }))
  t.mock.method(engine, 'startCodexSession', async () => { throw upstream })
  const retry = {
    nextAttemptAt: '2026-09-20T12:00:00Z',
    resetAt: null,
    reason: 'provider-limit',
    allQuotaExhausted: true,
    exhaustedCount: 1,
    unmeasuredCount: 0,
  }
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    accountResolver: async () => ({
      rotated: true,
      account: { name: 'backup', provider: 'codex' },
      attempts: [{ account: 'primary', status: 'exhausted' }],
      retry,
    }),
  })
  const request = {
    sessionId: 'frozen-final-retry',
    accountRetry: { excludeAccounts: ['primary'], recheckAttempt: 2 },
    requestKeys: { threadId: 'node-42', treeAnchors: ['root-node', 'node-42'] },
    treeIdentity: { selfName: 'Worker', managerName: 'Controller' },
  }
  await assert.rejects(host.startSession(request), error => {
    assert.equal(error.code, 'ENGINE_START_FROZEN')
    assert.deepEqual(error.startOutcome, {
      requestSessionId: request.sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    assert.deepEqual(error.accountRetry, {
      provider: 'codex',
      account: 'backup',
      attempts: [{ account: 'primary', status: 'exhausted' }],
      retry,
    })
    assert.strictEqual(error.cause, upstream)
    return true
  })
  assert.notEqual(host.sessionActivity(request.sessionId), null)
  await assert.rejects(host.closeSession({ sessionId: request.sessionId }), error => {
    assert.equal(error.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
    assert.deepEqual(error.startOutcome, {
      requestSessionId: request.sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    return true
  })
  assert.notEqual(host.sessionActivity(request.sessionId), null)
  await assert.rejects(host.closeAll(), error => {
    assert.equal(error.name, 'AggregateError')
    assert.equal(error.errors?.[0]?.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
    return true
  })
  assert.notEqual(host.sessionActivity(request.sessionId), null)
})

test('a post-dispatch no-handle start keeps provider custody across revoke retry in closeSession', async t => {
  const engine = require(enginePath)
  const upstream = Object.assign(new Error('provider admitted without a close handle'), {
    code: 'ENGINE_NO_CLOSE_HANDLE',
  })
  t.mock.method(engine, 'startCodexSession', async () => { throw upstream })
  let revokeCalls = 0
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: {
      bind() { return { bound: true, credential: 'A'.repeat(43) } },
      revoke() {
        revokeCalls += 1
        if (revokeCalls === 1) throw Object.assign(new Error('credential revoke failed'), { code: 'AUTHORITY_REVOKE_FAILED' })
      },
    },
  })
  const request = { sessionId: 'no-handle-close-session' }

  await assert.rejects(host.startSession(request), error => {
    assert.equal(error.code, 'AGENT_SESSION_CLEANUP_FAILED')
    assert.deepEqual(error.startOutcome, {
      requestSessionId: request.sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    return true
  })
  assert.equal(revokeCalls, 1)
  await assert.rejects(host.closeSession({ sessionId: request.sessionId }), error => {
    assert.equal(error.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
    return true
  })
  assert.equal(revokeCalls, 2)
  assert.notEqual(host.sessionActivity(request.sessionId), null)
})

test('a post-dispatch no-handle start keeps provider custody across revoke retry in closeAll', async t => {
  const engine = require(enginePath)
  const upstream = Object.assign(new Error('provider admitted without a close handle'), {
    code: 'ENGINE_NO_CLOSE_HANDLE',
  })
  t.mock.method(engine, 'startCodexSession', async () => { throw upstream })
  let revokeCalls = 0
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: {
      bind() { return { bound: true, credential: 'B'.repeat(43) } },
      revoke() {
        revokeCalls += 1
        if (revokeCalls === 1) throw Object.assign(new Error('credential revoke failed'), { code: 'AUTHORITY_REVOKE_FAILED' })
      },
    },
  })
  const request = { sessionId: 'no-handle-close-all' }

  await assert.rejects(host.startSession(request), error => {
    assert.equal(error.code, 'AGENT_SESSION_CLEANUP_FAILED')
    return true
  })
  await assert.rejects(host.closeAll(), error => {
    assert.equal(error.name, 'AggregateError')
    assert.equal(error.errors?.[0]?.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
    return true
  })
  assert.equal(revokeCalls, 2)
  assert.notEqual(host.sessionActivity(request.sessionId), null)
})

test('the local host seam retains and releases a reservation-only record without a provider lease', async () => {
  await withLocalEngineModule(async () => {
    const setupError = Object.assign(new Error('reservation state unavailable'), { code: 'RESOURCE_STATE_SETUP_FAILED' })
    const makeGovernor = ({ failFirstRelease = false } = {}) => {
      const token = Object.freeze({ reservation: failFirstRelease ? 'local-failure' : 'local-close-all' })
      let reads = 0
      let releases = 0
      let failed = false
      const resourceGovernor = {
        get releases() { return releases },
        reserve() {
          return {
            ok: true,
            token,
            get state() {
              if (reads++ === 0) throw setupError
              return { mode: 'unrestricted', configuredMode: 'unrestricted', measuredAt: Date.now(), bootstrapController: false }
            },
          }
        },
        release(releasedToken) {
          assert.strictEqual(releasedToken, token)
          releases += 1
          if (failFirstRelease && !failed) {
            failed = true
            throw Object.assign(new Error('reservation release failed'), { code: 'RESOURCE_RELEASE_FAILED' })
          }
        },
        revalidate() { return { ok: true } },
        ready() {},
      }
      return resourceGovernor
    }

    const closeSessionGovernor = makeGovernor({ failFirstRelease: true })
    const closeSessionHost = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => 64 * 1024 ** 3,
      resourceGovernor: closeSessionGovernor,
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    const closeSessionId = 'local-reservation-close-session'
    assert.throws(() => closeSessionHost.startSession({ sessionId: closeSessionId, tier: 'local' }), error => {
      assert.equal(error.code, setupError.code)
      assert.deepEqual(error.startOutcome, {
        requestSessionId: closeSessionId, admission: 'not-admitted', cleanup: 'pending', custody: 'cleanup-pending',
      })
      return true
    })
    assert.notEqual(closeSessionHost.sessionActivity(closeSessionId), null)
    await assert.rejects(closeSessionHost.closeSession({ sessionId: closeSessionId }), { code: 'RESOURCE_RELEASE_FAILED' })
    assert.notEqual(closeSessionHost.sessionActivity(closeSessionId), null)
    assert.deepEqual(await closeSessionHost.closeSession({ sessionId: closeSessionId }), {
      sessionId: closeSessionId, closed: true,
    })
    assert.equal(closeSessionGovernor.releases, 2)
    assert.equal(closeSessionHost.sessionActivity(closeSessionId), null)
    await closeSessionHost.closeAll()

    const concurrentGovernor = makeGovernor()
    const concurrentHost = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => 64 * 1024 ** 3,
      resourceGovernor: concurrentGovernor,
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    const concurrentId = 'local-reservation-concurrent-close'
    assert.throws(() => concurrentHost.startSession({ sessionId: concurrentId, tier: 'local' }), error => {
      assert.equal(error.code, setupError.code)
      return true
    })
    assert.deepEqual(await Promise.all([
      concurrentHost.closeSession({ sessionId: concurrentId }),
      concurrentHost.closeSession({ sessionId: concurrentId }),
    ]), [
      { sessionId: concurrentId, closed: true },
      { sessionId: concurrentId, closed: true },
    ])
    assert.equal(concurrentGovernor.releases, 1)
    assert.equal(concurrentHost.sessionActivity(concurrentId), null)
    await concurrentHost.closeAll()

    const closeAllGovernor = makeGovernor()
    const closeAllHost = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => 64 * 1024 ** 3,
      resourceGovernor: closeAllGovernor,
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    const closeAllId = 'local-reservation-close-all'
    assert.throws(() => closeAllHost.startSession({ sessionId: closeAllId, tier: 'local' }), error => {
      assert.equal(error.code, setupError.code)
      return true
    })
    await closeAllHost.closeAll()
    assert.equal(closeAllGovernor.releases, 1)
    assert.equal(closeAllHost.sessionActivity(closeAllId), null)
  })
})

test('a released outcome from an older same-id invocation cannot release a newer pending start', async t => {
  const sessionId = 'same-id-invocation-replay'
  let lowMemory = true
  let priorError = null
  const engine = require(enginePath)
  t.mock.method(engine, 'startCodexSession', async () => { throw priorError })
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => (lowMemory ? 0 : 64 * 1024 ** 3),
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  try {
    assert.throws(() => host.startSession({ sessionId, tier: 'luna' }), error => {
      priorError = error
      assert.deepEqual(error.startOutcome, {
        requestSessionId: sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none',
      })
      return true
    })
    assert.equal(host.sessionActivity(sessionId), null)
    lowMemory = false

    const { deps, agentSessions } = buildDeps(host.startSession.bind(host))
    deps.getAgentHost = () => host
    deps.currentAgentHost = () => host
    const surface = createAgentCommandSurface(deps)
    const result = await surface.run('agent:start', { sessionId, tier: 'luna' }, windowPrincipal)

    assert.equal(result.ok, false)
    assert.notStrictEqual(result, priorError)
    assert.deepEqual(result.startOutcome, {
      requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    assert.equal(agentSessions.get(sessionId).state, 'close-failed')
    assert.notEqual(host.sessionActivity(sessionId), null)
  } finally {
    try { await host.closeAll() } catch { /* unknown provider custody remains addressable for the next retry */ }
  }
})

test('a released same-id error from an older invocation cannot release a newer finalizer custody record', async t => {
  const sessionId = 'same-id-finalizer-replay'
  let invocation = 0
  let priorError
  const engine = require(enginePath)
  t.mock.method(engine, 'startCodexSession', async () => {
    invocation += 1
    if (invocation === 1) return { close() {} }
    throw new Error('new invocation provider failure')
  })
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  try {
    await assert.rejects(host.startSession({ sessionId, tier: 'luna' }), error => {
      priorError = error
      assert.deepEqual(error.startOutcome, {
        requestSessionId: sessionId, admission: 'unknown', cleanup: 'confirmed', custody: 'none',
      })
      return true
    })
    assert.equal(host.sessionActivity(sessionId), null)

    const startAdmission = {
      assertCurrent() {},
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() { throw priorError },
      },
    }
    const { deps, agentSessions } = buildDeps(host.startSession.bind(host))
    deps.parseAgentStart = value => ({ ...value })
    deps.getAgentHost = () => host
    deps.currentAgentHost = () => host
    const surface = createAgentCommandSurface(deps)
    const result = await surface.run('agent:start', { sessionId, tier: 'luna', startAdmission }, windowPrincipal)

    assert.equal(result.ok, false)
    assert.notStrictEqual(result, priorError)
    assert.deepEqual(result.startOutcome, {
      requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    assert.equal(agentSessions.get(sessionId).state, 'close-failed')
    assert.notEqual(host.sessionActivity(sessionId), null)
  } finally {
    try { await host.closeAll() } catch { /* the newer invocation remains addressable */ }
  }
})

test('unknown provider custody serializes closeSession and closeAll resource release and remains retryable', async () => {
  await withLocalEngineModule(async () => {
    const sessionId = 'unknown-resource-concurrent-close'
    const token = Object.freeze({ reservation: sessionId })
    let releases = 0
    let releaseEntered
    const releaseEnteredPromise = new Promise(resolve => {
      releaseEntered = resolve
    })
    let rejectConcurrentRelease
    const concurrentRelease = new Promise((resolve, reject) => {
      rejectConcurrentRelease = reject
      void resolve
    })
    concurrentRelease.catch(() => {})
    const rejectPendingRelease = (() => {
      let rejected = false
      return () => {
        if (rejected) return
        rejected = true
        rejectConcurrentRelease(Object.assign(new Error('concurrent release failed'), {
          code: 'RESOURCE_RELEASE_FAILED',
        }))
      }
    })()
    const resourceGovernor = {
      get releases() { return releases },
      reserve() {
        return {
          ok: true,
          token,
          get state() {
            return {
              mode: 'unrestricted',
              configuredMode: 'unrestricted',
              measuredAt: Date.now(),
              bootstrapController: false,
            }
          },
        }
      },
      release(releasedToken, releasedSessionId) {
        assert.strictEqual(releasedToken, token)
        assert.equal(releasedSessionId, sessionId)
        releases += 1
        if (releases === 1) throw Object.assign(new Error('startup resource release failed'), {
          code: 'RESOURCE_RELEASE_FAILED',
        })
        if (releases === 2) {
          releaseEntered()
          return concurrentRelease
        }
        if (releases === 3) return undefined
        throw new Error('resource release was not serialized')
      },
      revalidate() { return { ok: true } },
      ready() {},
    }
    const host = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => 64 * 1024 ** 3,
      resourceGovernor,
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    let closeSession = null
    let closeAll = null
    let bothClosed = null

    try {
      await assert.rejects(host.startSession({ sessionId, tier: 'local' }), error => {
        assert.deepEqual(error.startOutcome, {
          requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
        })
        return true
      })
      assert.notEqual(host.sessionActivity(sessionId), null)
      closeSession = host.closeSession({ sessionId })
      closeAll = host.closeAll()
      let closeSessionSettled = false
      const trackedCloseSession = closeSession.then(
        value => {
          closeSessionSettled = true
          return value
        },
        error => {
          closeSessionSettled = true
          throw error
        },
      )
      let closeAllSettled = false
      const trackedCloseAll = closeAll.then(
        value => {
          closeAllSettled = true
          return value
        },
        error => {
          closeAllSettled = true
          throw error
        },
      )
      let bothSettled = false
      bothClosed = Promise.allSettled([trackedCloseSession, trackedCloseAll]).then(results => {
        bothSettled = true
        return results
      })
      let releaseTimer
      try {
        await Promise.race([
          releaseEnteredPromise,
          new Promise((_, reject) => {
            releaseTimer = setTimeout(() => reject(new Error('release did not enter within the bounded wait')), 1000)
          }),
        ])
      } finally {
        clearTimeout(releaseTimer)
      }
      assert.equal(resourceGovernor.releases, 2)
      const held = host.sessionActivity(sessionId)
      assert.notEqual(held, null)
      assert.equal(held.closing, true)
      await Promise.resolve()
      assert.equal(closeSessionSettled, false)
      assert.equal(closeAllSettled, false)
      assert.equal(bothSettled, false)
      rejectPendingRelease()
      const results = await bothClosed
      assert.equal(results[0].status, 'rejected')
      assert.equal(results[1].status, 'rejected')
      assert.notEqual(host.sessionActivity(sessionId), null)

      await assert.rejects(host.closeSession({ sessionId }), error => {
        assert.equal(error.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
        assert.deepEqual(error.startOutcome, {
          requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
        })
        return true
      })
      assert.equal(resourceGovernor.releases, 3)
      assert.notEqual(host.sessionActivity(sessionId), null)
    } finally {
      rejectPendingRelease()
      if (bothClosed) await bothClosed
      try { await host.closeAll() } catch { /* provider custody is intentionally retained */ }
    }
  })
})

test('unknown provider custody serializes two closeSession callers and remains retryable', async () => {
  await withLocalEngineModule(async () => {
    const sessionId = 'unknown-resource-double-close-session'
    const token = Object.freeze({ reservation: sessionId })
    let releases = 0
    let releaseEntered
    const releaseEnteredPromise = new Promise(resolve => {
      releaseEntered = resolve
    })
    let rejectConcurrentRelease
    const concurrentRelease = new Promise((resolve, reject) => {
      rejectConcurrentRelease = reject
      void resolve
    })
    concurrentRelease.catch(() => {})
    const rejectPendingRelease = (() => {
      let rejected = false
      return () => {
        if (rejected) return
        rejected = true
        rejectConcurrentRelease(Object.assign(new Error('concurrent release failed'), {
          code: 'RESOURCE_RELEASE_FAILED',
        }))
      }
    })()
    const resourceGovernor = {
      get releases() { return releases },
      reserve() {
        return {
          ok: true,
          token,
          get state() {
            return {
              mode: 'unrestricted',
              configuredMode: 'unrestricted',
              measuredAt: Date.now(),
              bootstrapController: false,
            }
          },
        }
      },
      release(releasedToken, releasedSessionId) {
        assert.strictEqual(releasedToken, token)
        assert.equal(releasedSessionId, sessionId)
        releases += 1
        if (releases === 1) throw Object.assign(new Error('startup resource release failed'), {
          code: 'RESOURCE_RELEASE_FAILED',
        })
        if (releases === 2) {
          releaseEntered()
          return concurrentRelease
        }
        if (releases === 3) return undefined
        throw new Error('resource release was not serialized')
      },
      revalidate() { return { ok: true } },
      ready() {},
    }
    const host = createAgentHost({
      enginePath,
      defaultCwd: root,
      freeMemory: () => 64 * 1024 ** 3,
      resourceGovernor,
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    let firstClose = null
    let secondClose = null
    let bothClosed = null

    try {
      await assert.rejects(host.startSession({ sessionId, tier: 'local' }), error => {
        assert.deepEqual(error.startOutcome, {
          requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
        })
        return true
      })
      firstClose = host.closeSession({ sessionId })
      secondClose = host.closeSession({ sessionId })
      let firstCloseSettled = false
      const trackedFirstClose = firstClose.then(
        value => {
          firstCloseSettled = true
          return value
        },
        error => {
          firstCloseSettled = true
          throw error
        },
      )
      let secondCloseSettled = false
      const trackedSecondClose = secondClose.then(
        value => {
          secondCloseSettled = true
          return value
        },
        error => {
          secondCloseSettled = true
          throw error
        },
      )
      let bothSettled = false
      bothClosed = Promise.allSettled([trackedFirstClose, trackedSecondClose]).then(results => {
        bothSettled = true
        return results
      })
      let releaseTimer
      try {
        await Promise.race([
          releaseEnteredPromise,
          new Promise((_, reject) => {
            releaseTimer = setTimeout(() => reject(new Error('double-close release did not enter within the bounded wait')), 1000)
          }),
        ])
      } finally {
        clearTimeout(releaseTimer)
      }
      assert.equal(resourceGovernor.releases, 2)
      const held = host.sessionActivity(sessionId)
      assert.notEqual(held, null)
      assert.equal(held.closing, true)
      await Promise.resolve()
      assert.equal(firstCloseSettled, false)
      assert.equal(secondCloseSettled, false)
      assert.equal(bothSettled, false)
      rejectPendingRelease()
      const results = await bothClosed
      assert.equal(results[0].status, 'rejected')
      assert.equal(results[1].status, 'rejected')
      assert.notEqual(host.sessionActivity(sessionId), null)

      await assert.rejects(host.closeSession({ sessionId }), error => {
        assert.equal(error.code, 'AGENT_SESSION_CLEANUP_UNPROVEN')
        assert.deepEqual(error.startOutcome, {
          requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
        })
        return true
      })
      assert.equal(resourceGovernor.releases, 3)
      assert.notEqual(host.sessionActivity(sessionId), null)
    } finally {
      rejectPendingRelease()
      if (bothClosed) await bothClosed
      try { await host.closeAll() } catch { /* provider custody is intentionally retained */ }
    }
  })
})

test('the actual host and command surface carry an admitted start outcome together', async () => {
  const sessionId = 'joined-admitted-start'
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  const { deps, agentSessions } = buildDeps(host.startSession.bind(host))
  deps.getAgentHost = () => host
  deps.currentAgentHost = () => host
  const surface = createAgentCommandSurface(deps)
  try {
    const result = await surface.run('agent:start', { sessionId }, windowPrincipal)
    assert.notEqual(result.ok, false, result.reason)
    assert.equal(result.sessionId, sessionId)
    assert.deepEqual(result.startOutcome, {
      requestSessionId: sessionId, admission: 'admitted', cleanup: 'not-required', custody: 'session',
    })
    assert.equal(agentSessions.get(sessionId).state, 'ready')
  } finally {
    await host.closeAll()
  }
})

test('the actual host and command surface preserve accountRetry on uncertain startup', async t => {
  const engine = require(enginePath)
  const upstream = Object.freeze(Object.assign(new Error('frozen provider startup'), {
    code: 'ENGINE_START_FROZEN',
  }))
  t.mock.method(engine, 'startCodexSession', async () => { throw upstream })
  const retry = {
    nextAttemptAt: '2026-09-20T12:00:00Z',
    resetAt: null,
    reason: 'provider-limit',
    allQuotaExhausted: true,
    exhaustedCount: 1,
    unmeasuredCount: 0,
  }
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    accountResolver: async () => ({
      rotated: true,
      account: { name: 'backup', provider: 'codex' },
      attempts: [{ account: 'primary', status: 'exhausted' }],
      retry,
    }),
  })
  const sessionId = 'joined-account-retry'
  const request = {
    sessionId,
    accountRetry: { excludeAccounts: ['primary'], recheckAttempt: 2 },
    requestKeys: { threadId: 'node-42', treeAnchors: ['root-node', 'node-42'] },
    treeIdentity: { selfName: 'Worker', managerName: 'Controller' },
  }
  const { deps, agentSessions } = buildDeps(host.startSession.bind(host))
  deps.parseAgentStart = value => ({ ...value })
  deps.getAgentHost = () => host
  deps.currentAgentHost = () => host
  const surface = createAgentCommandSurface(deps)
  try {
    const result = await surface.run('agent:start', request, windowPrincipal)
    assert.equal(result.ok, false)
    assert.deepEqual(result.startOutcome, {
      requestSessionId: sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending',
    })
    assert.deepEqual(result.accountRetry, {
      provider: 'codex',
      account: 'backup',
      attempts: [{ account: 'primary', status: 'exhausted' }],
      retry,
    })
    assert.equal(agentSessions.get(sessionId).state, 'close-failed')
  } finally {
    try { await host.closeAll() } catch { /* provider custody is intentionally retained */ }
  }
})

test('completed host cleanup remains authoritative when an unmarked finalizer error follows it', async t => {
  const engine = require(enginePath)
  let closeCalls = 0
  t.mock.method(engine, 'startCodexSession', async () => ({
    /* Deliberately malformed startup reply with a valid close handle. */
    close() { closeCalls += 1 },
  }))
  const sessionId = 'joined-finalizer-after-cleanup'
  const finalizerError = Object.assign(new Error('listener finalizer failed'), {
    code: 'START_FINALIZER_FAILED',
  })
  const startAdmission = {
    assertCurrent() {},
    signal: {
      aborted: false,
      addEventListener() {},
      removeEventListener() { throw finalizerError },
    },
  }
  const host = createAgentHost({
    enginePath,
    defaultCwd: root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  const { deps, agentSessions } = buildDeps(host.startSession.bind(host))
  deps.parseAgentStart = value => ({ ...value })
  deps.getAgentHost = () => host
  deps.currentAgentHost = () => host
  const surface = createAgentCommandSurface(deps)
  try {
    const result = await surface.run('agent:start', { sessionId, startAdmission }, windowPrincipal)
    assert.equal(result.ok, false)
    assert.notEqual(result.code, finalizerError.code)
    assert.deepEqual(result.startOutcome, {
      requestSessionId: sessionId, admission: 'unknown', cleanup: 'confirmed', custody: 'none',
    })
    assert.equal(closeCalls, 1)
    assert.equal(host.sessionActivity(sessionId), null)
    assert.equal(agentSessions.has(sessionId), false)
  } finally {
    await host.closeAll()
  }
})

test('the selected main/preload wiring remains a pass-through for the structured start result', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
  assert.match(main, /ipcMain\.handle\('mc-agent:start'/)
  assert.match(main, /getAgentCommandSurface\(\)\.run\('agent:start', value, principal\)/)
  assert.ok(preload.includes("start: request => ipcRenderer.invoke('mc-agent:start', request)"))
})
