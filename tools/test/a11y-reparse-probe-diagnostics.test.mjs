import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { prepareCurrentCodexCredentialStage } from '../lib/a11y-codex-auth.mjs'

const profile = String.raw`C:\Users\ToolsEnabled-Dev`
const sentinel = 'injected diagnostic text must not escape'

function attempt(probe) {
  const calls = { probes: 0, metadata: 0, mutations: 0 }
  const options = {
    platform: 'win32', pathApi: path.win32, currentUserHome: profile,
    environment: { SystemRoot: String.raw`C:\Windows` },
    childProcess: {
      execFileSync(executable, argv, configuration) {
        calls.probes += 1
        assert.equal(executable, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
        assert.equal(configuration.timeout, 60_000)
        assert.equal(configuration.windowsHide, true)
        assert.deepEqual(configuration.stdio, ['pipe', 'pipe', 'pipe'])
        return probe(JSON.parse(configuration.input))
      },
    },
    fs: {
      lstatSync() { calls.metadata += 1; throw new Error('metadata sentinel') },
      copyFileSync() { calls.mutations += 1; throw new Error('copy must not run') },
      unlinkSync() { calls.mutations += 1; throw new Error('unlink must not run') },
      rmSync() { calls.mutations += 1; throw new Error('rm must not run') },
    },
  }
  let failure
  try {
    prepareCurrentCodexCredentialStage(
      path.win32.join(profile, '.codex'),
      path.win32.join(profile, 'AppData', 'Local', 'Temp', 'probe-test', '.codex'),
      options,
    )
  } catch (error) { failure = error }
  assert.equal(failure?.code, 'A11Y_CODEX_AUTH_STAGE_REFUSED')
  assert.equal(calls.probes, 1)
  assert.equal(calls.mutations, 0)
  assert.equal(failure.message.includes(profile), false)
  assert.equal(failure.message.includes(sentinel), false)
  return { failure, calls }
}

function processFailure(code) {
  return () => { throw Object.assign(new Error(sentinel), { code, stdout: sentinel, stderr: sentinel }) }
}

test('a timed-out reparse process reports its budget and measured elapsed time', () => {
  const { failure, calls } = attempt(processFailure('ETIMEDOUT'))
  assert.equal(failure.reason, 'reparse_probe_timed_out')
  assert.equal(failure.budgetMs, 60_000)
  assert.equal(Number.isFinite(failure.elapsedMs) && failure.elapsedMs >= 0, true)
  assert.match(failure.message, /elapsed_ms=\d+:budget_ms=60000$/)
  assert.equal(calls.metadata, 0)
})

test('a missing reparse executable has a distinct fail-closed reason', () => {
  const { failure, calls } = attempt(processFailure('ENOENT'))
  assert.equal(failure.reason, 'reparse_probe_missing_executable')
  assert.equal(calls.metadata, 0)
})

test('other reparse process failures remain distinct from bad output and do not disclose child diagnostics', () => {
  const { failure, calls } = attempt(processFailure('EACCES'))
  assert.equal(failure.reason, 'reparse_probe_failed')
  assert.equal(calls.metadata, 0)
})

for (const [label, output] of [
  ['invalid JSON', sentinel],
  ['non-array JSON', '{}'],
  ['invalid reparse bits', '[0,2]'],
  ['incomplete no-reparse result', '[0]'],
]) {
  test('reparse ' + label + ' is rejected as bad output before filesystem access', () => {
    const { failure, calls } = attempt(() => output)
    assert.equal(failure.reason, 'reparse_probe_bad_output')
    assert.equal(calls.metadata, 0)
  })
}

test('an early positive reparse result preserves the path refusal', () => {
  const { failure, calls } = attempt(() => '[0,1]')
  assert.equal(failure.reason, 'source_reparse')
  assert.equal(calls.metadata, 0)
})

test('a complete ordinary-path result reaches the filesystem guard without copying', () => {
  const { failure, calls } = attempt(paths => JSON.stringify(paths.map(() => 0)))
  assert.equal(failure.reason, 'source_unavailable')
  assert.equal(calls.metadata, 1)
})
