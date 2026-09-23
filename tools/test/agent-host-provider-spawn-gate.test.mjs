// R38-app (packaged-QA safety): does the app's REAL "start a tree circle"
// path -- shell/agent-host.cjs's startSession(), the function
// shell/tree-node-command.cjs's `command: request => dispatchTreeSpawn(request)`
// ultimately drives -- honour the engine's no-provider switch
// (TOOLSENABLED_REFUSE_PROVIDER_SPAWN)?
//
// agent-host.cjs owns no child_process require of its own (grep confirms it).
// It resolves a Codex or Claude session by require()ing the CAPABILITY
// PAYLOAD's own src/lib/agent-engine/{codex-process,claude-cli-process}.js
// IN-PROCESS (PAYLOAD_ENGINE_MODULE / PAYLOAD_CLAUDE_ENGINE_MODULE in
// agent-host.cjs) and calling their exported startCodexSession/
// startClaudeSession directly -- there is no subprocess boundary between the
// Electron host and the engine code that ultimately calls
// src/lib/proc/hidden-spawn.js's spawnHidden(), so the switch this test sets
// on `process.env` here is the exact same process.env spawnHidden() reads.
// If that wiring is real, no app-side gate needs writing; this test is the
// proof, not a fix.
//
// ASSERTED for BOTH codex and claude, against the REAL capability payload
// (never a re-implemented fixture engine -- see canonical-root.mjs, and
// tools/test/agent-control-target.test.mjs for the loud-skip convention this
// file reuses when no payload is staged):
//   1. With the switch set, host.startSession() rejects with the named
//      HIDDEN_SPAWN_PROVIDER_REFUSED code and the fake binary's log file is
//      never created -- nothing was started.
//   2. Without it, the fake binary -- resolved off a real PATH lookup, not a
//      passed-in absolute command -- is genuinely invoked, and its log
//      records real argv.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { providerCliExecutable } from '../../shell/provider-cli-presence.cjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

const ENGINE_ROOT = canonicalRootForTests()
const CODEX_ENGINE_PATH = join(ENGINE_ROOT, 'src', 'lib', 'agent-engine', 'codex-process.js')
const HIDDEN_SPAWN_PATH = join(ENGINE_ROOT, 'src', 'lib', 'proc', 'hidden-spawn.js')
const requireEngine = createRequire(import.meta.url)
const WORKER_KEY = 'TOOLSENABLED_PROVIDER_GATE_WORKER'
const FIXTURE_KEY = 'TOOLSENABLED_PROVIDER_GATE_FIXTURE'
const TIMEOUT_MS = 90_000

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
}

function scratchRoot() {
  const candidate = tmpdir()
  if (process.platform === 'win32') {
    const { assertAccountProfilePath } = requireEngine(join(ENGINE_ROOT, 'src/lib/account-profile-boundary.js'))
    // Use the OS account, not a synthetic '/' or an environment-selected peer.
    assertAccountProfilePath(candidate, { profileRoot: userInfo().homedir, requireOwnedProfile: true, field: 'provider gate scratch' })
  }
  return realpathSync(candidate)
}

function engineMissing() {
  return !existsSync(CODEX_ENGINE_PATH)
}

const SKIP_REASON =
  `No capability payload staged at ${ENGINE_ROOT}: this suite drives the REAL engine's ` +
  'agent-engine modules through shell/agent-host.cjs, never a re-implemented fixture. ' +
  'Run `npm run pack:capability` (see tools/pack-capability-layer.mjs), or set ' +
  'MC_CANONICAL_ROOT / TOOLSENABLED_SOURCE / private/capability-source.owner.json, then re-run.'

// Only the external provider protocol is a fixture. A real Node process writes
// its own argv and exits after accepting startup input. The Windows .cmd and
// POSIX executable are found by the real engine's normal PATH resolution.
function writeFakeProvider(binDir, name, logFile) {
  const program = join(binDir, `${name}-offline.cjs`)
  const version = name === 'codex'
    ? `codex-cli ${requireEngine(join(ENGINE_ROOT, 'src/lib/agent-engine/codex-adapter.js')).CODEX_CLI_VERSION}`
    : 'offline-claude-fixture 0.0.0'
  writeFileSync(program, `const fs = require('node:fs')\n`
    + `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\\n')\n`
    + `if (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(version + '\n')})\n`
    + `else { process.stdin.resume(); setTimeout(() => process.exit(0), 100) }\n`)
  const target = join(binDir, name + (process.platform === 'win32' ? '.cmd' : ''))
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
  const batchQuote = value => `"${value.replaceAll('%', '%%')}"`
  writeFileSync(target, process.platform === 'win32'
    ? `@echo off\r\n${batchQuote(process.execPath)} ${batchQuote(program)} %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(program)} "$@"\n`, { mode: 0o755 })
  return target
}

async function withHostFixture(t, provider, run) {
  // The engine memoizes its resolved runtime-state root. Each provider fixture
  // swaps TOOLSENABLED_STATE_ROOT, so clear that test-only cache before the
  // next host resolves its credential and ledger paths.
  requireEngine(join(ENGINE_ROOT, 'src/lib/runtime-state-root.js')).resetStateRootForTests()
  const parent = process.platform === 'win32' ? process.env[FIXTURE_KEY] : scratchRoot()
  if (process.platform === 'win32') {
    const { assertAccountProfilePath } = requireEngine(join(ENGINE_ROOT, 'src/lib/account-profile-boundary.js'))
    assertAccountProfilePath(parent, { profileRoot: userInfo().homedir, requireOwnedProfile: true, field: 'owned provider worker root' })
    assert.equal(realpathSync(parent), parent)
  }
  const root = mkdtempSync(join(parent, 'agent-host-provider-gate-'))
  const binDir = join(root, 'bin')
  const workDir = join(root, 'work')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const codexLog = join(root, 'codex.log')
  const claudeLog = join(root, 'claude.log')
  const providerPrograms = {
    codex: writeFakeProvider(binDir, 'codex', codexLog),
    claude: writeFakeProvider(binDir, 'claude', claudeLog),
  }

  const savedEnvironment = { ...process.env }
  const systemRoot = process.env.SystemRoot
  const hosts = []
  t.after(async () => {
    try {
      for (const host of hosts) await bounded(host.closeAll(), 'offline host cleanup')
      // The retained Windows Job owns removal after every descendant ends.
      if (process.platform !== 'win32') rmSync(root, { recursive: true, force: true })
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, savedEnvironment)
    }
  })
  // Exclude owner auth, provider installation fallbacks, and every product
  // state variable. Keep only ordinary OS executables needed by containment.
  const keep = /^(?:SystemRoot|WINDIR|ComSpec|PATHEXT|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i
  for (const name of Object.keys(process.env)) if (!keep.test(name)) delete process.env[name]
  const accountRoot = process.platform === 'win32' ? userInfo().homedir : '/'
  const systemPaths = process.platform === 'win32' ? [join(systemRoot, 'System32')] : ['/usr/bin', '/bin']
  Object.assign(process.env, {
    PATH: [binDir, ...systemPaths].join(delimiter), USERPROFILE: accountRoot,
    HOME: join(root, 'home'), APPDATA: join(root, 'appdata'), CODEX_HOME: join(root, 'codex-home'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
    TEMP: root, TMP: root, TMPDIR: root,
  })
  // Keep this runnable against the packaged runtime too: engine test helpers
  // are intentionally absent from a capability payload. Every durable sink
  // that an actual host startup may load is explicitly inside this fixture.
  const stateFiles = {
    LOCALAPPDATA: 'local-app-data',
    TOOLSENABLED_STATE_ROOT: 'local-app-data/ToolsEnabled Provider Gate Fixture/capability',
    TOOLSENABLED_AUDIT_DB: 'audit.sqlite3', TOOLSENABLED_VAULT_PATH: 'vault.json',
    TOOLSENABLED_AUDIT_JSONL_PATH: 'actions.jsonl', TOOLSENABLED_AUDIT_TEXT_PATH: 'actions.log',
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: 'audit-emergency.jsonl', TOOLSENABLED_KILLSWITCH_PATH: 'KILLSWITCH',
    TOOLSENABLED_STATE_PATH: 'state.sqlite3', TOOLSENABLED_SCHEDULER_LEGACY_PATH: 'jobs.json',
    TOOLSENABLED_OWNER_LEDGER_FILE: 'reports/OWNER-REQUEST-LEDGER.json',
    TOOLSENABLED_ACTIVE_REQUEST_PATH: 'state/active-request.json',
    TOOLSENABLED_OWNER_DELIVERY_PATH: 'state/owner-delivery.json',
    TOOLSENABLED_BROWSER_PROFILE_PATH: 'browser-profile', TOOLSENABLED_BROWSER_OWNER_PATH: 'state/browser-owner.json',
    TOOLSENABLED_PLAYWRIGHT_OUTPUT_PATH: 'playwright-output',
    TOOLSENABLED_FLEET_SUPERVISOR_LOG_PATH: 'fleet-supervisor.log',
    TOOLSENABLED_PROVIDER_STATE_FILE: 'provider-state/cli-providers.json',
    XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state',
  }
  for (const [name, relative] of Object.entries(stateFiles)) process.env[name] = join(root, relative)
  for (const name of ['HOME', 'APPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'LOCALAPPDATA', 'TOOLSENABLED_STATE_ROOT']) mkdirSync(process.env[name], { recursive: true })

  // The normal app resolver refreshes Windows PATH from the registry before
  // searching the inherited PATH. Supply the fixture PATH as its search value
  // so this offline proof cannot select an owner's installed provider. The
  // real resolver still finds the ordinary executable through real stat calls.
  const resolveProvider = id => providerCliExecutable(id, {
    env: { ...process.env },
    searchPath: { directories: process.env.PATH.split(delimiter), complete: true },
  })
  const comparablePath = value => process.platform === 'win32' ? value.toLowerCase() : value
  for (const [id, program] of Object.entries(providerPrograms)) {
    const resolved = resolveProvider(id)
    assert.equal(typeof resolved, 'string', `the fixture PATH must resolve ${id}`)
    assert.equal(comparablePath(realpathSync(resolved)), comparablePath(realpathSync(program)),
      `the actual resolver must select the owned offline ${id} program`)
  }

  const makeHost = () => {
    const host = createAgentHost({
      enginePath: CODEX_ENGINE_PATH,
      defaultCwd: workDir,
      profileRoot: accountRoot,
      startProviderProbe: () => provider.label,
      providerCommandResolver: resolveProvider,
      freeMemory: () => 64 * 1024 * 1024 * 1024,
      confinementPlanner: () => ({
        ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {},
      }),
    })
    hosts.push(host)
    return host
  }

  return run({ makeHost, codexLog, claudeLog })
}

async function inWindowsJob(t, provider) {
  const root = mkdtempSync(join(scratchRoot(), 'agent-host-provider-job-'))
  const { spawnInJob } = requireEngine(join(ENGINE_ROOT, 'src/lib/windows-job-control.js'))
  const { safeLaunchEnvironment } = requireEngine(join(ENGINE_ROOT, 'src/lib/providers/subscription-launch-env.js'))
  const env = { ...process.env, [WORKER_KEY]: provider.label, [FIXTURE_KEY]: root, MC_CANONICAL_ROOT: ENGINE_ROOT }
  for (const name of Object.keys(env)) if (/^NODE_TEST_/i.test(name)) delete env[name]
  const child = spawnInJob(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
    cwd: dirname(fileURLToPath(import.meta.url)), env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit: true,
  }, { safeLaunchEnvironment, recordDirectory: join(root, 'control'), assemblyCacheDirectory: join(root, 'assembly'), cleanupTimeoutMs: 15000 })
  let output = '', spawnError = null, cleanupProven = false
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  child.on('error', error => { spawnError = error })
  try {
    const ready = await bounded(child.jobReady, 'offline worker Job readiness')
    assert.ok(ready.rootPid > 0 && ready.wrapperPid > 0 && ready.rootStartTicks && ready.wrapperStartTicks)
    const outcome = await bounded(child.jobOutcome, 'offline worker completion')
    const closed = await bounded(child.jobClosed, 'offline worker wrapper close')
    cleanupProven = outcome.type === 'exit' && outcome.activeProcesses === 0 && child._closed === true && !outcome.failure && !closed.failure
    assert.equal(cleanupProven, true, 'the real Job must prove that every offline descendant ended')
    assert.equal(spawnError, null)
    assert.equal(outcome.exitCode, 0, output)
    assert.equal(closed.code, 0, output)
    assert.equal(closed.signal, null, output)
    for (const [name, expected] of [['tests', 1], ['pass', 1], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
      assert.match(output, new RegExp(`^# ${name} ${expected}\\r?$`, 'm'), output)
    }
    t.diagnostic(JSON.stringify({ platform: process.platform, jobId: ready.jobId, rootPid: ready.rootPid,
      rootStartTicks: ready.rootStartTicks, wrapperPid: ready.wrapperPid, wrapperStartTicks: ready.wrapperStartTicks,
      activeProcesses: outcome.activeProcesses, wrapperClosed: child._closed }))
  } finally {
    if (!cleanupProven) {
      const outcome = await bounded(child.terminateJob(), 'offline worker cancellation')
      const closed = await bounded(child.jobClosed, 'offline worker cancellation close')
      cleanupProven = ['exit', 'terminated'].includes(outcome.type) && outcome.activeProcesses === 0 && child._closed === true && !outcome.failure && !closed.failure
    }
    assert.equal(cleanupProven, true, 'retain fixture evidence if descendant cleanup is unresolved')
    assert.equal(realpathSync(root), root, 'only the owned ordinary fixture directory may be removed')
    rmSync(root, { recursive: true, force: true })
  }
}

const PROVIDERS = [
  { label: 'codex', startOptions: {}, log: 'codexLog' },
  { label: 'claude', startOptions: { tier: 'claude-sonnet' }, log: 'claudeLog' },
]

for (const provider of PROVIDERS) {
  if (process.env[WORKER_KEY] && process.env[WORKER_KEY] !== provider.label) continue
  test(`agent-host startSession refuses a real ${provider.label} spawn while the switch is set, and starts one for real once it is not`, { timeout: 180_000 }, async t => {
    if (engineMissing()) return t.skip(SKIP_REASON)
    if (process.platform === 'win32' && !process.env[WORKER_KEY]) return inWindowsJob(t, provider)

    // Loaded from the REAL staged payload, not re-declared, so this test can
    // never drift from whatever string the engine itself refuses on.
    const { PROVIDER_SPAWN_REFUSAL_VARIABLE } = requireEngine(HIDDEN_SPAWN_PATH)
    assert.equal(typeof PROVIDER_SPAWN_REFUSAL_VARIABLE, 'string')

    await withHostFixture(t, provider, async ({ makeHost, codexLog, claudeLog }) => {
      const logFile = provider.log === 'codexLog' ? codexLog : claudeLog

      // ---- 1. Switch ON: the real fake binary is never reached. ---------
      process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = '1'
      const refusedHost = makeHost()
      let refused = null
      try {
        await refusedHost.startSession({ sessionId: `${provider.label}-refused`, ...provider.startOptions })
      } catch (error) {
        refused = error
      }
      assert.ok(refused, `startSession must reject the ${provider.label} tier while the switch is set`)
      assert.equal(refused.code, 'HIDDEN_SPAWN_PROVIDER_REFUSED',
        'the rejection names itself HIDDEN_SPAWN_PROVIDER_REFUSED, the same code src/lib/proc/hidden-spawn.js throws')
      assert.equal(existsSync(logFile), false,
        `the fake ${provider.label} binary was never started -- its log file does not exist`)
      await refusedHost.closeAll()

      // ---- 2. Switch OFF: the real fake binary, resolved off PATH, runs. -
      delete process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE]
      const controlHost = makeHost()
      const startupEvents = []
      controlHost.onEvent(event => {
        if (startupEvents.length < 20) startupEvents.push({
          type: event.type, code: event.code || event.error?.code || null,
          message: String(event.message || event.error?.message || '').slice(0, 2048),
          reason: event.reason || null,
        })
      })
      let startupError = null
      try {
        await controlHost.startSession({ sessionId: `${provider.label}-control`, ...provider.startOptions })
      } catch (error) {
        // The fixture answers no real provider protocol, so the session may
        // not reach a fully "started" state -- irrelevant here. What this
        // case proves is narrower and sufficient: the binary was reached at
        // all, which the log below is the only honest witness of.
        startupError = { code: error?.code || null, message: String(error?.message || error) }
      }
      const startupObserved = () => existsSync(logFile) && readFileSync(logFile, 'utf8').trim().split('\n')
        .some(line => { try { return !JSON.parse(line).argv.includes('--version') } catch { return false } })
      const deadline = Date.now() + 15_000
      while (!startupObserved() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      t.diagnostic(JSON.stringify({ provider: provider.label, startupError, startupEvents, startupObserved: startupObserved() }))
      assert.equal(existsSync(logFile), true,
        `without the switch the fake ${provider.label} binary was actually invoked -- its log file was created; startup=${JSON.stringify(startupError)}`)
      const invocations = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(invocations.some(row => row.pid > 0 && row.argv.length > 0 && !row.argv.includes('--version')),
        'the real startup argv, beyond an availability probe, must reach the offline process')
      await controlHost.closeAll()
    })
  })
}
