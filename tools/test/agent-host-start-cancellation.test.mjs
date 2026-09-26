import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { userInfo } from 'node:os'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { createAgentHost } from '../../shell/agent-host.cjs'
/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require = createRequire(import.meta.url)
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
const PROFILE_ROOT = process.platform === 'win32' ? userInfo().homedir : path.parse(ENGINE).root
const SCRATCH_ROOT = ownedFixtureTempRoot()
const ISSUED = Buffer.alloc(32, 0x41).toString('base64url')
const flush = () => new Promise(resolve => setImmediate(resolve))
const capture = promise => promise.then(value => ({ value }), error => ({ error }))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function workspace(t) {
  const root = realpathSync(SCRATCH_ROOT)
  const relative = path.relative(PROFILE_ROOT, root)
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  const directory = mkdtempSync(path.join(root, 'toolsenabled-start-cancellation-'))
  t.after(() => {
    assert.ok(realpathSync(directory).toLowerCase().startsWith(`${root}${path.sep}`.toLowerCase()))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function makeHost(t, options = {}) {
  return createAgentHost({ freeMemory: TEST_FREE_MEMORY,
    enginePath: ENGINE,
    defaultCwd: workspace(t),
    profileRoot: PROFILE_ROOT,
    confinementPlanner: () => ({
      ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {},
    }),
    ...options,
  })
}

function opened(threadId = 'thread-started', close = () => {}) {
  return {
    threadId,
    adapter: { sendTurn: async () => ({ turnId: 'turn-1' }), interrupt() {}, answerApproval() {} },
    close,
  }
}

/* This engine remains in startup until its signal is aborted. No process or
   timer manufactures the outcome: Stop must reach the pending engine itself. */
function holdEngineStart(t, method) {
  const pending = []
  t.mock.method(engine, method, options => {
    const held = deferred()
    const entry = { ...held, signal: options.signal }
    pending.push(entry)
    const onAbort = () => held.reject(Object.assign(new Error('Engine startup aborted'), {
      name: 'AbortError', code: 'CODEX_START_ABORTED',
      // This fixture never spawns a child; retain its exact empty cleanup owner.
      retryCleanup: async () => {},
    }))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    return held.promise.finally(() => options.signal?.removeEventListener('abort', onAbort))
  })
  return pending
}

for (const resumed of [false, true]) {
  test(`Stop cancels a pending ${resumed ? 'resume' : 'fresh start'} before startup finishes`, async t => {
    const pending = holdEngineStart(t, resumed ? 'resumeCodexSession' : 'startCodexSession')
    const host = makeHost(t)
    const sessionId = resumed ? 'cancel-resume' : 'cancel-fresh'
    const start = capture(host.startSession({
      sessionId,
      ...(resumed ? { resumeThreadId: 'thread-saved' } : {}),
    }))
    let stop
    try {
      assert.equal(pending.length, 1)
      stop = host.closeSession({ sessionId })
      assert.equal(pending[0].signal?.aborted, true,
        'Stop must synchronously signal the engine while it has no close handle yet')
      const result = await Promise.race([stop, flush().then(() => 'still-starting')])
      assert.deepEqual(result, { sessionId, closed: true }, 'Stop waited for a startup that only cancellation can settle')
      assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
      await assert.rejects(host.sendTurn({ sessionId, text: 'must not run' }), { code: 'AGENT_SESSION_UNKNOWN' })
    } finally {
      for (const held of pending) held.resolve(opened())
      await start
      await stop
      await host.closeAll()
    }
  })
}

test('closeAll cancels every pending start without waiting on the first one', async t => {
  const pending = holdEngineStart(t, 'startCodexSession')
  const host = makeHost(t)
  const starts = ['cancel-all-one', 'cancel-all-two'].map(sessionId => capture(host.startSession({ sessionId })))
  let close
  try {
    close = host.closeAll()
    assert.equal(pending.length, 2)
    assert.ok(pending.every(held => held.signal?.aborted === true), 'shutdown must cancel all children before awaiting any one startup')
    assert.notEqual(await Promise.race([close.then(() => 'closed'), flush().then(() => 'still-starting')]), 'still-starting')
    assert.deepEqual((await Promise.all(starts)).map(result => result.error?.code), [
      'AGENT_SESSION_START_CANCELLED', 'AGENT_SESSION_START_CANCELLED',
    ])
  } finally {
    for (const held of pending) held.resolve(opened())
    await Promise.all(starts)
    await close
    await host.closeAll()
  }
})

test('Stop waits for a resolver that cannot cancel its selection write and never starts its late result', async t => {
  const account = deferred()
  let accountWrites = 0
  let engineStarts = 0
  let bindings = 0
  t.mock.method(engine, 'startCodexSession', async () => { engineStarts += 1; return opened() })
  const host = makeHost(t, {
    accountResolver: async () => {
      await account.promise
      accountWrites += 1
      return null
    },
    sessionAuthority: {
      bind: async () => { bindings += 1; return { bound: true, credential: ISSUED } },
      revoke: async () => {},
    },
  })
  const start = capture(host.startSession({ sessionId: 'cancel-account' }))
  let stop
  try {
    stop = host.closeSession({ sessionId: 'cancel-account' })
    const result = await Promise.race([stop, flush().then(() => 'still-selecting')])
    assert.equal(result, 'still-selecting', 'Stop abandoned a resolver that can still change the selected account')
    assert.equal(accountWrites, 0)
    account.resolve(null)
    assert.deepEqual(await stop, { sessionId: 'cancel-account', closed: true })
    assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
    await flush()
    assert.equal(accountWrites, 1, 'the old resolver must finish its mutation before Stop answers')
    assert.equal(bindings, 0, 'a cancelled selection must never mint a session credential')
    assert.equal(engineStarts, 0, 'a late account answer must never start a cancelled session')
  } finally {
    account.resolve(null)
    await start
    await stop
    await host.closeAll()
  }
})

test('Stop promptly cancels an account resolver that owns its cancellation boundary', async t => {
  let signal
  let engineStarts = 0
  t.mock.method(engine, 'startCodexSession', async () => { engineStarts += 1; return opened() })
  const host = makeHost(t, {
    accountResolver: (_request, options) => {
      signal = options.signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  const start = capture(host.startSession({ sessionId: 'cancel-owned-selection' }))
  try {
    const stop = host.closeSession({ sessionId: 'cancel-owned-selection' })
    assert.equal(signal.aborted, true)
    assert.deepEqual(await Promise.race([stop, flush().then(() => 'still-selecting')]), {
      sessionId: 'cancel-owned-selection', closed: true,
    })
    assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
    assert.equal(engineStarts, 0)
  } finally {
    await host.closeAll()
  }
})

test('the production account adapter forwards the startup signal and preserves cancellation', async () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const begin = main.indexOf('async function resolveSessionAccount(')
  const end = main.indexOf('\n/* The same directory the machine record', begin)
  assert.ok(begin >= 0 && end > begin)
  const calls = []
  const controller = new AbortController()
  const resolve = runInNewContext(`(${main.slice(begin, end)})`, {
    loadRotation: () => ({
      resolveAccountForSession: request => {
        calls.push(request)
        return new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      },
    }),
    resolveServicesRootForAccounts: () => SCRATCH_ROOT,
    ACCOUNT_HOME_DIR: PROFILE_ROOT,
    ACCOUNT_REGISTRY_FILE: path.join(SCRATCH_ROOT, 'fixture-accounts.json'),
    PROVIDER_ISOLATION_REQUESTED: false,
    selectionPolicyFromRegistry: () => null,
  })
  const selecting = capture(resolve({ provider: 'codex', preferred: 'work', exact: true }, { signal: controller.signal }))
  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0].signal, controller.signal, 'the main adapter dropped startup cancellation before rotation')
  assert.equal(calls[0].preferred, 'work')
  assert.equal(calls[0].selectionMode, 'manual')
  controller.abort()
  assert.strictEqual((await selecting).error, controller.signal.reason, 'the adapter converted cancellation into the default-account fallback')
})

test('Stop waits for an in-flight authority bind to be revoked before it reports closed', async t => {
  const binding = deferred()
  let binds = 0
  const revocations = []
  let engineStarts = 0
  t.mock.method(engine, 'startCodexSession', async () => { engineStarts += 1; return opened() })
  const host = makeHost(t, {
    sessionAuthority: {
      bind: () => { binds += 1; return binding.promise },
      revoke: async request => { revocations.push(request.sessionId) },
    },
  })
  const start = capture(host.startSession({ sessionId: 'cancel-binding' }))
  let stop
  try {
    assert.equal(binds, 1)
    stop = host.closeSession({ sessionId: 'cancel-binding' })
    assert.equal(await Promise.race([stop.then(() => 'closed'), flush().then(() => 'binding')]), 'binding',
      'Stop cannot abandon a bind that might still issue a live credential')
    binding.resolve({ bound: true, credential: ISSUED })
    await stop
    assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
    assert.deepEqual(revocations, ['cancel-binding'])
    assert.equal(engineStarts, 0)
  } finally {
    binding.resolve({ bound: true, credential: ISSUED })
    await start
    await stop
    await host.closeAll()
  }
})

test('a provider that ignores cancellation still has its late child closed before Stop succeeds', async t => {
  const launch = deferred()
  let signal
  let childCloses = 0
  t.mock.method(engine, 'startCodexSession', options => { signal = options.signal; return launch.promise })
  const host = makeHost(t)
  const start = capture(host.startSession({ sessionId: 'cancel-late-child' }))
  let stop
  try {
    stop = host.closeSession({ sessionId: 'cancel-late-child' })
    assert.equal(signal?.aborted, true)
    assert.equal(await Promise.race([stop.then(() => 'closed'), flush().then(() => 'launching')]), 'launching')
    launch.resolve(opened('thread-late', () => { childCloses += 1 }))
    await stop
    assert.equal(childCloses, 1, 'a late successful spawn must be reclaimed, never orphaned')
    assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
  } finally {
    launch.resolve(opened('thread-late', () => { childCloses += 1 }))
    await start
    await stop
    await host.closeAll()
  }
})

test('closing a ready session uses its close handle without aborting its completed startup', async t => {
  let signal
  let childCloses = 0
  t.mock.method(engine, 'startCodexSession', async options => {
    signal = options.signal
    return opened('thread-ready', () => { childCloses += 1 })
  })
  const host = makeHost(t)
  try {
    await host.startSession({ sessionId: 'close-ready' })
    assert.equal(signal?.aborted, false)
    await host.closeSession({ sessionId: 'close-ready' })
    assert.equal(childCloses, 1)
    assert.equal(signal.aborted, false, 'startup cancellation must not become a second close channel for live sessions')
  } finally {
    await host.closeAll()
  }
})

for (const resumed of [false, true]) {
  test(`an unproven ${resumed ? 'resume' : 'start'} cleanup reaches its host retry before the original refusal returns`, async t => {
    const cleanup = deferred()
    let attempts = 0
    const unproven = Object.assign(new Error('Initial cleanup was unproven'), { code: 'CODEX_START_CLEANUP_UNPROVEN' })
    Object.defineProperty(unproven, 'retryCleanup', { value: () => {
      attempts += 1
      return cleanup.promise
    } })
    t.mock.method(engine, resumed ? 'resumeCodexSession' : 'startCodexSession', async () => { throw unproven })
    const host = makeHost(t)
    const sessionId = 'cleanup-before-refusal'
    const start = capture(host.startSession({ sessionId, ...(resumed ? { resumeThreadId: 'saved-thread' } : {}) }))
    try {
      await flush()
      assert.equal(attempts, 1, 'the host must reach the retained cleanup handle')
      assert.equal(await Promise.race([start, flush().then(() => 'cleanup-pending')]), 'cleanup-pending',
        'the original engine refusal escaped before host cleanup settled')
      assert.equal(host.sessionActivity(sessionId).closing, true)
      cleanup.resolve()
      assert.equal((await start).error, unproven,
        'the original code can describe the initial uncertainty after the host has confirmed cleanup')
      assert.equal(host.sessionActivity(sessionId), null, 'only confirmed cleanup may remove the session')
    } finally {
      cleanup.resolve()
      await start
      await host.closeAll()
    }
  })
}

for (const closeAll of [false, true]) {
  test(`${closeAll ? 'closeAll' : 'Stop'} retains an engine startup cleanup retry and refuses closure until it succeeds`, async t => {
    let cleanupProven = false
    let cleanupAttempts = 0
    const failedCleanup = Object.assign(new AggregateError([], 'Engine startup cleanup is unproven'), { code: 'CODEX_START_CLEANUP_UNPROVEN' })
    Object.defineProperty(failedCleanup, 'retryCleanup', {
      value: async () => {
        cleanupAttempts += 1
        if (!cleanupProven) throw new Error('Child termination is still unproven')
      },
    })
    t.mock.method(engine, 'startCodexSession', ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(failedCleanup), { once: true })
    }))
    const host = makeHost(t)
    const start = capture(host.startSession({ sessionId: 'cancel-engine-cleanup' }))
    try {
      const closing = await capture(closeAll ? host.closeAll() : host.closeSession({ sessionId: 'cancel-engine-cleanup' }))
      assert.ok(closing.error, 'the host reported closed without proof that startup children ended')
      assert.equal((await start).error?.code, 'AGENT_SESSION_CLEANUP_FAILED')
      assert.equal(cleanupAttempts, 2, 'startup cleanup and the requested close must both try the retained engine handle')
      cleanupProven = true
      if (closeAll) await host.closeAll()
      else assert.deepEqual(await host.closeSession({ sessionId: 'cancel-engine-cleanup' }), {
        sessionId: 'cancel-engine-cleanup', closed: true,
      })
      assert.equal(cleanupAttempts, 3, 'the same owned cleanup handle must survive for the successful retry')
    } finally {
      cleanupProven = true
      await host.closeAll()
    }
  })
}

for (const closeAll of [false, true]) {
  test(`${closeAll ? 'closeAll' : 'Stop'} retries a cancelled startup's credential cleanup and cannot report success while it fails`, async t => {
    const pending = holdEngineStart(t, 'startCodexSession')
    let refuseRevocation = true
    let revocations = 0
    const host = makeHost(t, {
      sessionAuthority: {
        bind: async () => ({ bound: true, credential: ISSUED }),
        revoke: async () => {
          revocations += 1
          if (refuseRevocation) throw Object.assign(new Error('Authority unavailable'), { code: 'TEST_REVOKE_FAILED' })
        },
      },
    })
    const start = capture(host.startSession({ sessionId: 'cancel-revoke-failure' }))
    let close
    try {
      await flush()
      assert.equal(pending.length, 1)
      close = capture(closeAll ? host.closeAll() : host.closeSession({ sessionId: 'cancel-revoke-failure' }))
      const result = await Promise.race([close, flush().then(() => ({ waiting: true }))])
      assert.equal(result.waiting, undefined, 'startup cancellation was never delivered')
      assert.ok(result.error, 'cleanup failed but the host reported that the session was closed')
      assert.equal((await start).error?.code, 'AGENT_SESSION_CLEANUP_FAILED')
      assert.equal(revocations, 2, 'the requested close must retry failed startup revocation before refusing')
      refuseRevocation = false
      if (closeAll) await host.closeAll()
      else await host.closeSession({ sessionId: 'cancel-revoke-failure' })
      assert.equal(revocations, 3, 'the failed cleanup handle must remain available for a later close retry')
    } finally {
      refuseRevocation = false
      for (const held of pending) held.resolve(opened())
      await start
      await close
      await host.closeAll()
    }
  })
}


test('remote admission revocation cancels a pending native start and leaves an accepted session running', async t => {
  const authority = new AbortController()
  const admission = {
    signal: authority.signal,
    assertCurrent() {
      if (authority.signal.aborted) throw Object.assign(new Error('revoked'), { code: 'MC_AGENT_CONNECTION_CLOSED' })
    },
  }
  const account = deferred()
  let starts = 0, closes = 0, nativeSignal
  t.mock.method(engine, 'startCodexSession', async options => {
    starts += 1
    nativeSignal = options.signal
    return opened('authorized-thread', () => { closes += 1 })
  })
  const host = makeHost(t, { accountResolver: async () => {
    await account.promise
    return { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }
  } })
  try {
    const pending = capture(host.startSession({ sessionId: 'revoked-account', startAdmission: admission }))
    authority.abort()
    account.resolve()
    assert.equal((await pending).error?.code, 'AGENT_SESSION_START_CANCELLED')
    assert.equal(starts, 0, 'a revoked account lookup must never launch a native provider')
    const authorized = new AbortController()
    await host.startSession({ sessionId: 'accepted', startAdmission: { signal: authorized.signal, assertCurrent() {} } })
    authorized.abort()
    assert.equal(starts, 1)
    assert.equal(nativeSignal.aborted, false, 'accepted startup is detached from remote admission')
    assert.equal(closes, 0, 'Disconnect must not close an accepted session')
    await host.closeSession({ sessionId: 'accepted' })
    assert.equal(closes, 1)
  } finally { account.resolve(); await host.closeAll() }
})

test('remote revocation during provider handshake cancels and reclaims its late exact child', async t => {
  const authority = new AbortController()
  const launch = deferred()
  let nativeSignal, closes = 0
  t.mock.method(engine, 'startCodexSession', options => { nativeSignal = options.signal; return launch.promise })
  const host = makeHost(t)
  const pending = capture(host.startSession({ sessionId: 'revoked-handshake', startAdmission: {
    signal: authority.signal,
    assertCurrent() { if (authority.signal.aborted) throw Object.assign(new Error('revoked'), { code: 'MC_AGENT_CONNECTION_CLOSED' }) },
  } }))
  try {
    authority.abort()
    assert.equal(nativeSignal.aborted, true)
    launch.resolve(opened('late-exact-child', () => { closes += 1 }))
    assert.equal((await pending).error?.code, 'AGENT_SESSION_START_CANCELLED')
    assert.equal(closes, 1)
  } finally { launch.resolve(opened()); await pending; await host.closeAll() }
})
