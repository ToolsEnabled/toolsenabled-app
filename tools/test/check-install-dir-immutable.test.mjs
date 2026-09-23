// Does the install-directory immutability gate actually refuse when it cannot
// inspect an unpacked application?  This deliberately runs the real command:
// checking source text cannot distinguish a live refusal from dead code.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-install-dir-immutable.mjs')

test('check-install-dir-immutable gives its packaged GUI a system-only PATH', () => {
  const source = readFileSync(TOOL, 'utf8')
  const start = source.indexOf('async function runGuiSession')
  const end = source.indexOf('/* -------------------------------------------------------------------- main */', start)
  assert.ok(start >= 0 && end > start, 'runGuiSession source must be present')
  const guiSource = source.slice(start, end)
  assert.match(
    guiSource,
    /sterileLaunchEnvironment\(\s*profile\s*,\s*process\.env\s*,\s*\{\s*systemPathOnly:\s*true\s*\}\s*\)/,
    'phase B must not pass a build wrapper PATH containing a foreign-profile entry into the packaged GUI',
  )
  assert.doesNotMatch(guiSource, /sterileLaunchEnvironment\(\s*profile\s*\)/)
})

test('check-install-dir-immutable states the sterile state root its RunAsNode phases assert on', () => {
  // Since engine 81b14e15 a packaged payload given no TOOLSENABLED_STATE_ROOT
  // anchors its state to the installing account's own profile (from the process
  // token, not APPDATA), so a launch that says nothing writes into the builder's
  // real per-user root and phases A, D and E fail against the scratch roots they
  // assert on -- measured on the 1.0.40 r10 cut.
  const source = readFileSync(TOOL, 'utf8')
  const start = source.indexOf('function sterileEnvironment(profile)')
  const end = source.indexOf('async function terminateTree', start)
  assert.ok(start >= 0 && end > start, 'sterileEnvironment source must be present')
  const environmentSource = source.slice(start, end)
  assert.ok(
    environmentSource.includes('TOOLSENABLED_STATE_ROOT: path.join(profile.appData'),
    'sterileEnvironment must state TOOLSENABLED_STATE_ROOT under the sterile profile appData',
  )
  assert.match(environmentSource, /ELECTRON_RUN_AS_NODE:\s*'1'/, 'the payload phases still run the binary as Node')
})

test('check-install-dir-immutable canonicalizes only its already-created fenced scratch directory', () => {
  const source = readFileSync(TOOL, 'utf8')
  const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  const createdAt = code.indexOf('const scratchEntry = await mkdtemp(')
  const canonicalAt = code.indexOf('const scratch = canonicalizeCreatedQaProfile(scratchEntry, {', createdAt)
  const aliasAt = code.indexOf('trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome)', canonicalAt)
  const derivedAt = code.indexOf('sterileProfileDirectories(scratch)', aliasAt)
  assert.ok(createdAt >= 0 && canonicalAt > createdAt && aliasAt > canonicalAt && derivedAt > aliasAt,
    'the newly created scratch root must be canonicalized before any phase profile is derived')
  assert.doesNotMatch(code, /canonicalizeCreatedQaProfile\(reported|realpath\(reported/,
    'the untrusted path returned by phase E must never be probed or followed')
})

function run(directory) {
  const result = spawnSync(process.execPath, [TOOL, directory], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

test('check-install-dir-immutable refuses a missing unpacked application', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'check-install-dir-immutable-'))
  const missing = path.join(base, 'not-built')
  try {
    const { code, output } = run(missing)
    assert.equal(code, 1, `the gate passed without looking at an application:\n${output}`)
    assert.match(output, /Not an unpacked ToolsEnabled build:/)
    assert.match(output, /ToolsEnabled\.exe is missing\./)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('check-install-dir-immutable refuses an empty payload enumeration', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'check-install-dir-immutable-'))
  try {
    // Satisfy the first presence check so this specifically reaches the empty
    // capability directory rather than merely repeating the missing-root case.
    writeFileSync(path.join(base, 'ToolsEnabled.exe'), '')
    mkdirSync(path.join(base, 'resources', 'capability'), { recursive: true })

    const { code, output } = run(base)
    assert.equal(code, 1, `the gate accepted an empty set of payload files:\n${output}`)
    assert.match(output, /Not an unpacked ToolsEnabled build:/)
    assert.match(output, /resources[/\\]capability[/\\]PAYLOAD\.json is missing\./)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
