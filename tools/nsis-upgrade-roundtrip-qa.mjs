#!/usr/bin/env node

// Discoverable release-gate wrapper for the real NSIS upgrade program. The
// PowerShell harness builds and silently installs two isolated product versions,
// provokes removal of the old install directory, and proves the vault, audit
// ledger, and a nested file survived byte-for-byte.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import candidateScope from './lib/qa-candidate-scope.cjs'
import { UNMEASURABLE_MARK } from './machine-steadiness.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UNMEASURABLE_STATUSES = new Set([3, 4])

// The exact quoted basename is executable evidence for the PowerShell
// delegation rule in check-drivers-discovered.mjs.
export const POWERSHELL_BASENAME = 'nsis-upgrade-roundtrip.ps1'
export const POWERSHELL_SCRIPT = path.join(REPO_ROOT, 'tools', POWERSHELL_BASENAME)

const PASS_MARK = 'PASS: the vault, the signed ledger and a NESTED file all survived the upgrade byte-identical.'
const CLEAN_MARK = 'residue: stateRoot=False regKey=False buildRoot=False'

export function runNsisUpgradeRoundtrip({
  platform = process.platform,
  scriptExists = existsSync,
  spawn = spawnSync,
} = {}) {
  if (platform !== 'win32') {
    return {
      ok: false,
      exitCode: 2,
      output: '',
      unmeasurable: true,
      reason: `the NSIS upgrade roundtrip requires Windows (got ${platform})`,
    }
  }
  if (!scriptExists(POWERSHELL_SCRIPT)) {
    return {
      ok: false,
      exitCode: 2,
      output: '',
      unmeasurable: true,
      reason: `${POWERSHELL_BASENAME} is missing`,
    }
  }

  const result = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', POWERSHELL_SCRIPT,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  if (result.error || result.status === null) {
    return {
      ok: false,
      exitCode: 2,
      output,
      unmeasurable: true,
      reason: `powershell.exe could not start: ${result.error?.message ?? 'no exit status'}`,
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      exitCode: result.status,
      output,
      unmeasurable: UNMEASURABLE_STATUSES.has(result.status),
      reason: result.status === 3
        ? `${POWERSHELL_BASENAME} refused to run (exit 3): the isolation guard tripped, an installer build failed, `
          + 'or the slate was not clean. Nothing was measured about the upgrade.'
        : result.status === 4
          ? `${POWERSHELL_BASENAME} reported INCONCLUSIVE (exit 4): the old install directory survived, so `
            + '`RMDir /r $INSTDIR` never ran and the rescue was never put under the thing it defends against.'
          : `${POWERSHELL_BASENAME} exited ${result.status}`,
    }
  }
  if (!output.includes(PASS_MARK)) {
    return {
      ok: false,
      exitCode: 1,
      output,
      reason: 'PowerShell exited zero without reaching the byte-for-byte upgrade assertion',
    }
  }
  if (!output.includes(CLEAN_MARK)) {
    return {
      ok: false,
      exitCode: 1,
      output,
      reason: 'the roundtrip left its state root, registry key, or isolated build root behind',
    }
  }
  return { ok: true, exitCode: 0, output, reason: null }
}

export function reportNsisUpgradeRoundtrip(result, {
  stdout = value => process.stdout.write(value),
  stderr = value => process.stderr.write(value),
} = {}) {
  if (result.output) stdout(result.output.endsWith('\n') ? result.output : `${result.output}\n`)
  if (result.ok) {
    stdout('NSIS upgrade roundtrip: 1/1 checks passed\n')
    return 0
  }
  if (result.unmeasurable) {
    stdout(`${UNMEASURABLE_MARK} ${result.reason}\n`)
    return result.exitCode || 3
  }
  stderr(`NSIS upgrade roundtrip: FAIL: ${result.reason}\n0/1 checks passed\n`)
  return result.exitCode || 1
}

function isDirectRun() {
  return Boolean(process.argv[1])
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectRun()) {
  // --release names an unpacked candidate, while the current roundtrip builds
  // two synthetic installer identities. Do not silently test checkout source.
  candidateScope.refuseUnsupportedCandidate({ repoRoot: REPO_ROOT, driver: 'nsis-upgrade-roundtrip',
    reason: process.platform !== 'win32'
      ? `the NSIS upgrade roundtrip requires Windows (got ${process.platform}); it also needs two installer inputs under an isolated identity`
      : 'the current roundtrip builds two synthetic installers from checkout source; selected installer inputs must be wired before this can qualify the requested candidate',
  })
  process.exitCode = reportNsisUpgradeRoundtrip(runNsisUpgradeRoundtrip())
}
