// A pwsh 7 PSModulePath MUST NOT REACH WINDOWS POWERSHELL 5.1 CHILDREN.
//
// MEASURED on the 1.0.45 cut of 2026-09-17. Of its 40 strict reds, 22 carried
// one of three signatures and none of them reproduced from a bash parent:
//
//   tools/test/tree-node-command.test.mjs  (6)  MC_TREE_COMMAND_ACL_UNAVAILABLE
//                                               "Application spool ACL could not be verified",
//                                               thrown from runWindowsAclPass, which needs Get-Acl
//   tools/test/audit-repair-native.test.mjs (14) AUDIT_REKEY_CUSTODY_UNAVAILABLE
//   tools/test/audit-identity-native.test.mjs (1) -- the PowerShell vault backend
//   tools/test/owned-job-native-profile.test.mjs (1)
//                                               "ConvertTo-SecureString ... was found in the module
//                                               'Microsoft.PowerShell.Security', but the module could not be loaded"
//
// ONE CAUSE. run-cut-final.ps1 launches the cut from pwsh 7. pwsh exports a
// PSModulePath whose PowerShell 7 module directories precede the 5.1 ones; node
// inherits that value verbatim and hands it to every powershell.exe 5.1 the
// suites spawn; 5.1 finds the Core build of Microsoft.PowerShell.Security first
// and refuses to load it. Every cmdlet in that module fails closed, which is
// all three signatures above.
//
// THE INTERMEDIATE NODE PROCESS IS LOAD-BEARING and is why this hid for so
// long. pwsh launching powershell.exe DIRECTLY is fine: 5.1 repairs the path
// itself. The cut always has node in between, so it never gets that repair.
//
// CONTROL, the four suites above, same pwsh parent, same scratch, only
// PSModulePath differing:
//   inherited from pwsh 7 -> 45 tests, 23 pass, 22 FAIL
//   emptied               -> 45 tests, 45 pass,  0 fail

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { buildDistChainEnvironment } from '../release-packager/cut-release-candidate.mjs'

const PWSH7_VALUE = [
  'C:\\Users\\Someone\\Documents\\PowerShell\\Modules',
  'C:\\Program Files\\PowerShell\\Modules',
  'c:\\program files\\windowsapps\\microsoft.powershell_7.6.6.0_x64__8wekyb3d8bbwe\\Modules',
  'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
].join(';')

const scratch = { scratchState: path.join('C:', 's'), scratchTemp: path.join('C:', 't') }

test('the dist chain never inherits the launcher PSModulePath on Windows', () => {
  const env = buildDistChainEnvironment({ PSModulePath: PWSH7_VALUE }, { workspaceSegments: ['fixture-workspace'], ...scratch, platform: 'win32' })
  assert.equal(env.PSModulePath, '',
    'a pwsh 7 module path reaching powershell.exe 5.1 fails Get-Acl, ConvertTo-SecureString and the vault backend')
  assert.ok(!String(env.PSModulePath).toLowerCase().includes('microsoft.powershell_7'),
    'no PowerShell 7 module directory may survive into the dist chain')
})

test('an absent PSModulePath is still emptied rather than left undefined on Windows', () => {
  const env = buildDistChainEnvironment({}, { workspaceSegments: ['fixture-workspace'], ...scratch, platform: 'win32' })
  assert.equal(env.PSModulePath, '',
    'the value must be explicit, so a parent that sets it later cannot leak in')
})

test('POSIX keeps the launcher environment, where the variable does not apply', () => {
  const env = buildDistChainEnvironment({ PSModulePath: PWSH7_VALUE }, { workspaceSegments: ['fixture-workspace'],
    scratchState: '/s', scratchTemp: '/t', platform: 'linux',
  })
  assert.equal(env.PSModulePath, PWSH7_VALUE,
    'Windows PowerShell 5.1 does not exist on Linux; nothing there needs this rewrite')
})

// AND THE CMDLETS THEMSELVES, NOT JUST THE VARIABLE.
//
// Everything above inspects the environment object. That proves the cut sets
// the value it means to and nothing about whether the value WORKS, which is the
// only thing the 22 reds were ever about. This spawns the real
// powershell.exe 5.1 the suites spawn and asserts on what the cmdlets RETURN.
test('Get-Acl and ConvertTo-SecureString succeed under the built environment and fail under a pwsh 7 parent', { skip: process.platform !== "win32" && "Windows PowerShell is measured on Windows" }, (t) => {
  const powershell = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(powershell)) {
    // A named refusal, not a silent pass: this box has no 5.1 to ask.
    assert.fail(`powershell.exe 5.1 is not at ${powershell}, so the cmdlets the 22 reds turned on were NOT exercised`)
  }

  // Asks for a VALUE back from each cmdlet, so a cmdlet that silently returned
  // nothing cannot read as success.
  const script = [
    "try { $a = Get-Acl -LiteralPath $env:SystemRoot; if ($a.Owner) { 'GETACL=ok' } else { 'GETACL=empty' } }",
    "catch { 'GETACL=fail' }",
    "try { $s = ConvertTo-SecureString 'synthetic-unused-value' -AsPlainText -Force; if ($s.Length -gt 0) { 'SECURE=ok' } else { 'SECURE=empty' } }",
    "catch { 'SECURE=fail' }",
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const ask = (env) => {
    const answer = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, env })
    return `${answer.stdout || ''}${answer.stderr || ''}`
  }

  const scratch = path.join(os.tmpdir(), 'w86-psmodulepath-probe')
  const built = buildDistChainEnvironment(process.env, { workspaceSegments: ['fixture-workspace'],
    scratchState: path.join(scratch, 'state'),
    scratchTemp: path.join(scratch, 't'),
    platform: 'win32',
  })
  assert.equal(built.PSModulePath, '', 'the built environment is the one under test')

  const good = ask(built)
  assert.match(good, /GETACL=ok/, `Get-Acl must work under the cut's environment; got: ${good.slice(0, 300)}`)
  assert.match(good, /SECURE=ok/, `ConvertTo-SecureString must work under the cut's environment; got: ${good.slice(0, 300)}`)
  /* THE NEGATIVE CONTROL, AND THE PREMISE I NEARLY ENCODED INSTEAD.
   *
   * The obvious control is to hand the child a pwsh 7 PSModulePath string and
   * require the cmdlets to fail. It does not work, and asserting it would have
   * pinned a premise my own measurement contradicts: from a BASH parent that
   * same string still yields GETACL=ok. Measured 2026-09-17, four ways:
   *   bash parent, ambient environment      -> ok
   *   bash parent, hand-set pwsh 7 path     -> ok
   *   pwsh 7 parent, inherited environment  -> FAIL, both cmdlets
   *   pwsh 7 parent, PSModulePath emptied   -> ok
   * so the breakage needs the pwsh-descended PARENT, not merely the string. The
   * intermediate node process is load-bearing; pwsh launching powershell.exe
   * directly is repaired by 5.1 itself.
   *
   * So the control runs only where the premise holds -- under a parent that is
   * actually pwsh-descended, which is exactly the cut, since run-cut-final.ps1
   * launches it from pwsh 7. Elsewhere it says so BY NAME rather than asserting
   * a reproduction this parent cannot produce. */
  const ambient = String(process.env.PSModulePath || '')
  const pwshDescended = /[\/]PowerShell[\/]7|microsoft\.powershell_7/i.test(ambient)
  if (!pwshDescended) {
    t.diagnostic('negative control NOT run: this parent is not pwsh-descended, and a hand-set '
      + 'PSModulePath alone does not reproduce the breakage. Inside a cut this branch does run.')
    return
  }
  const poisoned = ask({ ...built, PSModulePath: ambient })
  assert.match(poisoned, /GETACL=fail/,
    `under a pwsh 7 parent the inherited module path must still break Get-Acl, or emptying it is no longer what fixed the 22; got: ${poisoned.slice(0, 300)}`)
  assert.match(poisoned, /SECURE=fail/,
    `and ConvertTo-SecureString with it; got: ${poisoned.slice(0, 300)}`)
})
