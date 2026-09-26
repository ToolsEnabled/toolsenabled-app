import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const WINDOWS_FIXTURE_PARENT = 'TOOLSENABLED_WINDOWS_FIXTURE_PARENT'

// An explicit scratch volume is useful when the real profile has a Git
// ancestor. It is an alternate owned boundary, never a replacement identity.
export function explicitWindowsFixtureParent(candidate = null) {
  if (!Object.hasOwn(process.env, WINDOWS_FIXTURE_PARENT)) return null
  if (process.platform !== 'win32') throw new Error('Alternate source fixture parents require Windows')
  const boundary = process.env[WINDOWS_FIXTURE_PARENT]
  const parent = candidate || boundary
  for (const directory of [boundary, parent]) {
    if (typeof directory !== 'string' || !/^[A-Za-z]:\\/.test(directory) ||
        directory.includes('/') || directory.slice(2).includes(':') ||
        directory.split('\\').some(part => /[. ]$/.test(part))) {
      throw new Error('Alternate source fixture parent must be an ordinary local drive path')
    }
  }
  if (candidate) {
    const relative = path.win32.relative(boundary, candidate)
    if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) {
      throw new Error('Alternate fixture allocation must stay below its explicit owned boundary')
    }
  }
  for (const directory of [boundary, parent]) inspectSourceFixtureHome(directory)
  const windows = process.env.SystemRoot
  if (!/^[A-Za-z]:\\Windows$/i.test(windows || '')) throw new Error('Windows system directory is unavailable')
  const powershell = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$parent = $env:TOOLSENABLED_WINDOWS_FIXTURE_PARENT
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FixtureVolume { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int length); }
'@
$target = New-Object Text.StringBuilder 4096
if ([FixtureVolume]::QueryDosDevice($parent.Substring(0,2), $target, $target.Capacity) -eq 0 -or $target.ToString() -notmatch '^\\Device\\HarddiskVolume[0-9]+$') { throw 'Fixture drive must resolve directly to a local disk volume' }
$allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$cursor = [IO.DirectoryInfo]::new($parent)
while ($null -ne $cursor) {
  $item = Get-Item -LiteralPath $cursor.FullName -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixture ancestors must be ordinary directories' }
  $acl = Get-Acl -LiteralPath $cursor.FullName
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or -not $acl.AreAccessRulesProtected) { throw 'Fixture ancestors require the current account owner and protected ACL' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'Fixture ACL must grant the current account access' }
  $ownerFull = $false
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited) { throw 'Fixture ACL permits an unapproved principal or inherited rule' }
    if ($rule.IdentityReference.Value -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownerFull = $true }
  }
  if (-not $ownerFull) { throw 'Fixture ACL must grant its current account owner full control' }
  $cursor = $cursor.Parent
}
[Console]::Out.Write('OWNED_FIXTURE_VOLUME_OK')
`
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024,
    env: { ...process.env, [WINDOWS_FIXTURE_PARENT]: parent } })
  if (output.trim() !== 'OWNED_FIXTURE_VOLUME_OK') throw new Error('Windows fixture ownership verification failed')
  // Repeat the non-following path/Git checks after the ownership observation.
  inspectSourceFixtureHome(parent)
  return boundary
}

// Strict source jobs share this preload through both the leaf planner and
// npm test. Evidence directories may themselves be inside an outer checkout;
// they cannot supply the "outside a repository" fixture premise.
export function inspectSourceFixtureHome(home, {
  platform = process.platform, filesystem = fs,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!['linux', 'win32'].includes(platform) || typeof home !== 'string' ||
      !paths.isAbsolute(home) || paths.normalize(home) !== home ||
      /[\x00-\x1f]/.test(home) || home === paths.parse(home).root) {
    throw new Error('Source fixture home must be an ordinary absolute account directory')
  }
  let cursor = paths.parse(home).root
  for (const segment of paths.relative(cursor, home).split(paths.sep)) {
    cursor = paths.join(cursor, segment)
    const entry = filesystem.lstatSync(cursor)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Source fixture home ancestors must be ordinary directories')
  }
  const actual = filesystem.realpathSync.native(home)
  const equal = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equal(actual, home)) throw new Error('Source fixture home resolves through a path alias')
  for (let current = home, count = 0; ; current = paths.dirname(current)) {
    if (++count > 64) throw new Error('Source fixture ancestor budget exceeded')
    let marker
    try { marker = filesystem.lstatSync(paths.join(current, '.git')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    // A file, directory, link or malformed marker all invalidate the premise.
    // Never follow or read marker contents.
    if (marker) throw new Error('Source fixture account home has a Git ancestor; no fixture was created')
    if (paths.dirname(current) === current) break
  }
  return home
}

export function retainedSourceFixtureEnvironment(root, home, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const same = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!['linux', 'win32'].includes(platform) || typeof root !== 'string' || typeof home !== 'string' ||
      !paths.isAbsolute(root) || !paths.isAbsolute(home) || paths.normalize(root) !== root ||
      !same(paths.dirname(root), home) || !/^te-source-fixture-[a-zA-Z0-9]{6}$/.test(paths.basename(root))) {
    throw new Error('Retained source fixture must be a fresh direct child of the current account')
  }
  return { TMPDIR: root, TEMP: root, TMP: root, TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1',
    TOOLSENABLED_TEST_RETAIN_FIXTURES: '1' }
}

export function prepareRetainedSourceFixture() {
  const home = explicitWindowsFixtureParent() || inspectSourceFixtureHome(os.userInfo().homedir)
  const root = fs.mkdtempSync(path.join(home, 'te-source-fixture-'))
  const entry = fs.lstatSync(root)
  if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error('Fresh source fixture is not an ordinary directory')
  }
  return { root, environment: retainedSourceFixtureEnvironment(root, home) }
}
