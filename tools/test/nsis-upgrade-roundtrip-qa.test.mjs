import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  POWERSHELL_BASENAME,
  POWERSHELL_SCRIPT,
  reportNsisUpgradeRoundtrip,
  runNsisUpgradeRoundtrip,
} from '../nsis-upgrade-roundtrip-qa.mjs'

const PASS_OUTPUT = [
  '[nsis-roundtrip] PASS: the vault, the signed ledger and a NESTED file all survived the upgrade byte-identical.',
  '[nsis-roundtrip] residue: stateRoot=False regKey=False buildRoot=False',
  '',
].join('\n')

test('the discoverable driver invokes the real PowerShell harness without a visible shell', () => {
  let invocation
  const result = runNsisUpgradeRoundtrip({
    platform: 'win32',
    scriptExists: () => true,
    spawn(command, args, options) {
      invocation = { command, args, options }
      return { status: 0, stdout: PASS_OUTPUT, stderr: '' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(invocation.command, 'powershell.exe')
  assert.deepEqual(invocation.args, [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', POWERSHELL_SCRIPT,
  ])
  assert.equal(invocation.options.windowsHide, true)
  assert.equal(invocation.options.cwd, path.dirname(path.dirname(POWERSHELL_SCRIPT)))
})

test('exit zero without proof or cleanup is still a failed roundtrip', () => {
  const run = stdout => runNsisUpgradeRoundtrip({
    platform: 'win32',
    scriptExists: () => true,
    spawn: () => ({ status: 0, stdout, stderr: '' }),
  })

  assert.equal(run('').ok, false)
  assert.match(run('').reason, /without reaching the byte-for-byte upgrade assertion/)
  assert.match(run(PASS_OUTPUT.replace('stateRoot=False', 'stateRoot=True')).reason, /left its state root/)
  assert.match(run(PASS_OUTPUT.replace('buildRoot=False', 'buildRoot=True')).reason, /isolated build root behind/)
})

test('PowerShell refusal, spawn failure, and the wrong operating system fail closed', () => {
  const refused = runNsisUpgradeRoundtrip({
    platform: 'win32',
    scriptExists: () => true,
    spawn: () => ({ status: 3, stdout: '[nsis-roundtrip] REFUSING', stderr: '' }),
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.exitCode, 3)
  assert.equal(refused.unmeasurable, true)

  const spawnFailure = runNsisUpgradeRoundtrip({
    platform: 'win32',
    scriptExists: () => true,
    spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('not found') }),
  })
  assert.equal(spawnFailure.exitCode, 2)
  assert.match(spawnFailure.reason, /could not start/)

  const wrongHost = runNsisUpgradeRoundtrip({ platform: 'linux' })
  assert.equal(wrongHost.ok, false)
  assert.equal(wrongHost.exitCode, 2)
  assert.equal(wrongHost.unmeasurable, true)
  assert.match(wrongHost.reason, /requires Windows/)
})

test('the driver emits a summary the packaged runner can cross-examine', () => {
  const out = []
  const err = []
  assert.equal(
    reportNsisUpgradeRoundtrip(
      { ok: true, exitCode: 0, output: PASS_OUTPUT, reason: null },
      { stdout: value => out.push(value), stderr: value => err.push(value) },
    ),
    0,
  )
  assert.match(out.at(-1), /1\/1 checks passed/)
  assert.deepEqual(err, [])

  out.length = 0
  assert.equal(
    reportNsisUpgradeRoundtrip(
      { ok: false, exitCode: 1, output: '', reason: 'proof missing' },
      { stdout: value => out.push(value), stderr: value => err.push(value) },
    ),
    1,
  )
  assert.match(err.at(-1), /0\/1 checks passed/)

  out.length = 0
  err.length = 0
  assert.equal(
    reportNsisUpgradeRoundtrip(
      { ok: false, exitCode: 3, output: '', unmeasurable: true, reason: 'the isolated build could not start' },
      { stdout: value => out.push(value), stderr: value => err.push(value) },
    ),
    3,
  )
  assert.match(out.at(-1), /CANNOT MEASURE.*isolated build could not start/)
  assert.equal(out.some(line => /checks passed/.test(line)), false)
  assert.deepEqual(err, [])
})

test('the delegated PowerShell program exists under the exact basename the guard reads', () => {
  assert.equal(POWERSHELL_BASENAME, 'nsis-upgrade-roundtrip.ps1')
  assert.equal(existsSync(POWERSHELL_SCRIPT), true)
})
