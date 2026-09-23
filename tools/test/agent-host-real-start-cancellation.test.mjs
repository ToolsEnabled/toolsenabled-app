import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { userInfo } from 'node:os'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const DEV_PROFILE = userInfo().homedir
const TIMEOUT_MS = 30_000
const capture = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
      }),
    ])
  } finally { clearTimeout(timer) }
}

function beneath(root, candidate) {
  const relative = path.relative(root, candidate)
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'the integration fixture must remain under its explicitly permitted root')
  return candidate
}

function fixtureProvider() {
  const fs = require('node:fs')
  const readline = require('node:readline')
  const record = phase => fs.appendFileSync(process.env.MC_OFFLINE_PHASES,
    `${JSON.stringify({ phase, pid: process.pid })}\n`, 'utf8')
  if (process.argv.includes('--version')) {
    record('version')
    if (process.env.MC_OFFLINE_HOLD === 'version') {
      setTimeout(() => process.exit(98), 45_000)
    } else process.stdout.write('codex-cli 0.153.0\n')
    return
  }
  if (!process.argv.includes('app-server')) process.exit(64)
  // Remain alive even if the adapter closes stdin. Only actual process cleanup
  // may satisfy Stop; EOF cannot manufacture a passing cleanup receipt.
  setTimeout(() => process.exit(98), 45_000)
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line)
    record(request.method)
    // Deliberately never answer initialize: cancellation must cross both the
    // host and the real engine before the fixture can end.
  })
}

function phases(directory) {
  try {
    return readFileSync(path.join(directory, 'phases.jsonl'), 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function waitForPhase(directory, phase, start) {
  let waiting = true
  try { return await bounded(Promise.race([
    (async () => {
      while (waiting) {
        const observed = phases(directory).find(row => row.phase === phase)
        if (observed) return observed
        await delay(20)
      }
    })(),
    start.then(result => {
      throw new Error(`The real engine settled before ${phase}: ${result.error?.code || 'unexpected success'}`)
    }),
  ]), `fake provider ${phase}`) } finally { waiting = false }
}

function alive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'only the owned fixture may provide a liveness PID')
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

/* The host, Codex engine, adapter, transport, cleanup helper and Windows Job
 * wrapper are all real. Only the external provider and permission plan are
 * fixtures. Three tiny engine-root forwarding modules prevent construction of
 * unrelated account/ledger/communication services against an owner's state.
 * The spawn interceptor refuses every command except our exact offline file.
 * Negative cleanup injection never invents a successful receipt: recovery must
 * use the same owned child and receive the real Job Object's zero-process proof.
 */
async function withRealEngine(phase, run) {
  const scratchRoot = ownedFixtureTempRoot()
  const engineRoot = ownedFixtureTempRoot({ selected: canonicalRootForTests() })
  const engineModule = path.join(engineRoot, 'src/lib/agent-engine/codex-process.js')
  const directory = mkdtempSync(path.join(scratchRoot, 'toolsenabled-real-start-cancel-'))
  const fixtureRoot = path.join(directory, 'engine')
  const command = path.join(directory, 'bin', 'codex.cmd')
  const provider = path.join(directory, 'offline-provider.cjs')
  const savedEnvironment = { ...process.env }
  const savedEngineModule = require.cache[engineModule]
  const children = []
  let hiddenSpawn, originalSpawn, host, start
  let cleanupResults = []
  try {
    for (const relative of ['bin', 'appdata', 'localappdata', 'codex-home', 'home', 'state-root',
      'engine/src/lib/agent-engine', 'engine/src/lib/providers']) {
      mkdirSync(path.join(directory, relative), { recursive: true })
    }
    writeFileSync(provider, `(${fixtureProvider.toString()})()\n`, 'utf8')
    writeFileSync(command, `@echo off\n"${process.execPath}" "${provider}" %*\n`, 'utf8')
    const forward = (relative, target) => writeFileSync(path.join(fixtureRoot, relative),
      `module.exports = require(${JSON.stringify(path.join(engineRoot, target))})\n`, 'utf8')
    forward('src/lib/agent-engine/codex-process.js', 'src/lib/agent-engine/codex-process.js')
    forward('src/lib/providers/subscription-launch-env.js', 'src/lib/providers/subscription-launch-env.js')
    writeFileSync(path.join(fixtureRoot, 'src/lib/agent-session-confinement.js'),
      `const { installationProfileRoot, assertAccountProfilePath, assertAccountProfileEnvironment } = require(${JSON.stringify(path.join(engineRoot, 'src/lib/agent-session-confinement.js'))})\n`
      + `module.exports = { installationProfileRoot, assertAccountProfilePath, assertAccountProfileEnvironment, confinedSessionPlan() { throw new Error('use the explicit offline plan') } }\n`, 'utf8')

    // Do not inherit auth, profile fallbacks, provider paths or runtime state.
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATH: `${path.dirname(command)};C:\\Windows\\System32`, PATHEXT: '.CMD',
      USERPROFILE: DEV_PROFILE, HOME: path.join(directory, 'home'),
      APPDATA: path.join(directory, 'appdata'), LOCALAPPDATA: path.join(directory, 'localappdata'),
      TEMP: scratchRoot, TMP: scratchRoot, CODEX_HOME: path.join(directory, 'codex-home'),
      TOOLSENABLED_STATE_ROOT: path.join(directory, 'state-root'),
      MC_OFFLINE_PHASES: path.join(directory, 'phases.jsonl'), MC_OFFLINE_HOLD: phase,
    })

    hiddenSpawn = require(path.join(engineRoot, 'src/lib/proc/hidden-spawn.js'))
    originalSpawn = hiddenSpawn.spawnHidden
    hiddenSpawn.spawnHidden = (spawnCommand, args, options) => {
      assert.equal(path.resolve(spawnCommand).toLowerCase(), command.toLowerCase(), 'refuse any real provider invocation')
      assert.equal(options.containProcessTree, true, 'both startup phases must own their complete process tree')
      const child = originalSpawn(spawnCommand, args, options)
      const entry = {
        child, phase: args.includes('--version') ? 'version' : 'initialize',
        blocked: false, primaryAttempts: 0, fallbackAttempts: 0,
        terminate: child.terminateJob.bind(child), fallback: child.terminateRetainedWrapper.bind(child),
        receipt: null,
      }
      child.jobOutcome.then(receipt => {
        entry.receipt = { type: receipt.type, activeProcesses: receipt.activeProcesses, failed: Boolean(receipt.failure) }
      }, () => {})
      child.terminateJob = (...args) => {
        entry.primaryAttempts += 1
        return entry.blocked ? Promise.reject(new Error('Offline fixture rejects cleanup control')) : entry.terminate(...args).then(receipt => {
          entry.receipt = { type: receipt.type, activeProcesses: receipt.activeProcesses, failed: Boolean(receipt.failure) }
          return receipt
        })
      }
      child.terminateRetainedWrapper = (...args) => {
        entry.fallbackAttempts += 1
        return entry.blocked ? Promise.reject(new Error('Offline fixture rejects wrapper fallback')) : entry.fallback(...args)
      }
      children.push(entry)
      return child
    }
    delete require.cache[engineModule]
    host = createAgentHost({
      // This offline process is a tiny Node fixture, not a model. Exercise
      // real startup/cancellation independently of unrelated host memory use;
      // agent-memory-admission and agent-resource-wiring test admission.
      freeMemory: () => 64 * 1024 * 1024 * 1024,
      enginePath: path.join(fixtureRoot, 'src/lib/agent-engine/codex-process.js'),
      defaultCwd: directory, profileRoot: DEV_PROFILE, startProviderProbe: () => 'codex',
      confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    })
    const sessionId = `offline-${phase}`
    start = capture(host.startSession({ sessionId,
      ...(phase === 'initialize' ? { resumeThreadId: 'offline-resume-thread' } : {}),
    }))
    const observed = await waitForPhase(directory, phase, start)
    const child = children.find(entry => entry.phase === phase)
    assert.ok(child, 'the actual engine must own the process that reached this phase')
    assert.equal(alive(observed.pid), true)
    await run({ host, start, sessionId, child, observed, children, directory })
  } finally {
    for (const entry of children) entry.blocked = false
    try {
      // Only retained handles created above are used, including on assertion
      // failure. Never discover or terminate a process by a recycled PID.
      cleanupResults = await Promise.allSettled(children.map(async entry => {
        const terminated = await capture(bounded(entry.terminate(), 'fixture job cleanup'))
        if (terminated.error) await bounded(entry.fallback(), 'fixture wrapper cleanup')
        await bounded(entry.child.jobClosed, 'fixture wrapper exit')
        const receipt = await bounded(entry.child.jobOutcome, 'fixture job outcome')
        assert.ok(['terminated', 'exit'].includes(receipt?.type), 'fixture cleanup needs a complete job outcome')
        assert.equal(receipt.activeProcesses, 0, 'fixture cleanup left child processes alive')
        assert.ok(!receipt.failure, 'fixture job cleanup reported failure')
      }))
      if (host) await bounded(host.closeAll(), 'fixture host cleanup')
      if (start) await bounded(start, 'fixture start settlement')
    } finally {
      if (hiddenSpawn) hiddenSpawn.spawnHidden = originalSpawn
      delete require.cache[engineModule]
      if (savedEngineModule) require.cache[engineModule] = savedEngineModule
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, savedEnvironment)
      if (cleanupResults.every(result => result.status === 'fulfilled')) {
        beneath(scratchRoot, realpathSync(directory))
        rmSync(directory, { recursive: true, force: true })
      }
    }
    assert.equal(cleanupResults.filter(result => result.status === 'rejected').length, 0, 'owned fixture cleanup failed')
  }
}

for (const phase of ['version', 'initialize']) {
  test(`real host and engine Stop during ${phase} confirms an empty Windows job`, { skip: process.platform !== 'win32' }, async () => {
    await withRealEngine(phase, async ({ host, start, sessionId, child, observed, children, directory }) => {
      const stopped = await bounded(capture(host.closeSession({ sessionId })), 'Stop')
      assert.equal(stopped.error?.code, undefined, 'Stop must finish real cleanup before it succeeds')
      assert.deepEqual(stopped.value, { sessionId, closed: true })
      assert.equal((await start).error?.code, 'AGENT_SESSION_START_CANCELLED')
      assert.equal(alive(observed.pid), false, 'Stop answered while the fake provider was still alive')
      assert.equal(child.receipt?.activeProcesses, 0)
      assert.ok(['terminated', 'exit'].includes(child.receipt?.type))
      assert.equal(child.receipt.failed, false)
      assert.equal(children.length, phase === 'version' ? 1 : 2, 'cancelled startup must not spawn a later phase')
      assert.deepEqual(phases(directory).map(row => row.phase), phase === 'version' ? ['version'] : ['version', 'initialize'])
    })
  })

  test(`real ${phase} cleanup refusal survives the engine-to-host handoff and can be retried`, { skip: process.platform !== 'win32' }, async () => {
    await withRealEngine(phase, async ({ host, start, sessionId, child, observed, children }) => {
      child.blocked = true
      const stopped = await bounded(capture(host.closeSession({ sessionId })), 'refused Stop')
      assert.equal(stopped.error?.code, 'CODEX_START_CLEANUP_UNPROVEN', 'Stop cannot forget the real engine cleanup refusal')
      const failedStart = (await start).error
      assert.equal(failedStart?.code, 'AGENT_SESSION_CLEANUP_FAILED')
      assert.equal(failedStart.errors[0].code, 'CODEX_START_CLEANUP_UNPROVEN')
      assert.equal(typeof failedStart.errors[0].retryCleanup, 'function')
      assert.equal(Object.keys(failedStart.errors[0]).includes('retryCleanup'), false, 'private handles must stay out of serialized errors')
      assert.ok(child.primaryAttempts >= 3, 'startup, host startup cleanup and explicit Stop must retain the same handle')
      assert.ok(child.fallbackAttempts >= 3)
      assert.equal(child.receipt, null, 'negative injection must not manufacture a zero-process receipt')
      assert.equal(alive(observed.pid), true, 'the refused cleanup must have a real process left to recover')
      const childCount = children.length
      child.blocked = false
      const retry = await bounded(capture(host.closeSession({ sessionId })), 'Stop retry')
      assert.equal(retry.error?.code, undefined, 'a later Stop must reach the retained real cleanup handle')
      assert.deepEqual(retry.value, { sessionId, closed: true })
      assert.equal(children.length, childCount, 'retry must not substitute a newly spawned process')
      assert.equal(alive(observed.pid), false)
      assert.equal(child.receipt?.activeProcesses, 0)
      assert.ok(['terminated', 'exit'].includes(child.receipt?.type))
      assert.equal(child.receipt.failed, false)
    })
  })
}
