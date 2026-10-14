import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const WINDOWS_FIXTURE_PARENT = 'TOOLSENABLED_WINDOWS_FIXTURE_PARENT'
const FIXTURE_BASENAME = /^te-source-fixture-[A-Za-z0-9]{6}$/

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

export const SOURCE_FIXTURE_PARENT = 'TOOLSENABLED_TEST_SOURCE_FIXTURE_PARENT'
export const SOURCE_FIXTURE_KEEP = 'TOOLSENABLED_TEST_SOURCE_FIXTURE_KEEP'

// WHY THIS IS NOT THE ACCOUNT HOME ANY MORE.
// The only real premise these fixtures need is "outside any repository":
// inspectSourceFixtureHome walks every ancestor and refuses a `.git` marker,
// because the strict *source* suites measure a fixture app/engine pair and
// cannot sit inside an outer checkout. `$HOME` merely happened to satisfy that
// on the owner's box; it was never the requirement, and using it leaked one
// retained `te-source-fixture-XXXXXX` directory per strict test-FILE process
// into the profile root. An OS temp root satisfies the same premise, and a
// caller may name its own parent instead. Windows keeps its explicit owned
// scratch volume (see explicitWindowsFixtureParent) because a Git marker at
// the drive root - `C:\.git` - disqualifies the profile AND its own temp dir.
function platformTempRoot() {
  const saved = {}
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (Object.hasOwn(process.env, key)) { saved[key] = process.env[key]; delete process.env[key] }
  }
  try { return os.tmpdir() }
  finally { for (const [key, value] of Object.entries(saved)) process.env[key] = value }
}

export function sourceFixtureParent({
  platform = process.platform, env = process.env, filesystem = fs,
  accountHome = null,
} = {}) {
  if (Object.hasOwn(env, SOURCE_FIXTURE_PARENT)) {
    const supplied = env[SOURCE_FIXTURE_PARENT]
    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new Error('Explicit source fixture parent cannot be empty')
    }
    const resolved = filesystem.realpathSync.native(supplied)
    return inspectSourceFixtureHome(resolved, { platform, filesystem })
  }
  if (platform === 'win32') {
    const owned = explicitWindowsFixtureParent()
    if (owned) return owned
    // WINDOWS STAYS IN THE PROFILE. With TEMP/TMP scrubbed, os.tmpdir() on
    // Windows is the system temp under %SystemRoot%: outside the account, while
    // strict suites hold their fixture inside the permitted Dev profile
    // (tree-standalone-binding-start-order.test.mjs refuses anything outside it
    // and accepts the profile's AppData\Local\Temp as the literal Dev temp
    // root). Use that temp root, taken from the OS account record rather than
    // TEMP, so a nested run gets a sibling, not a child.
    const profileTemp = path.win32.join(accountHome ?? os.userInfo().homedir, 'AppData', 'Local', 'Temp')
    return inspectSourceFixtureHome(filesystem.realpathSync.native(profileTemp), { platform, filesystem })
  }
  // DE-NEST. A fixture points TMPDIR at itself for the run it owns
  // (retainedSourceFixtureEnvironment), so a nested run would otherwise mint its
  // fixture INSIDE ours, and the next one inside that. Each level adds ~25 bytes
  // and run-isolated starts warning once a unix socket path passes 100, which the
  // strict transcript check reads as a refusal. Climb out of any fixture segments
  // so a nested run gets a SIBLING and the path length stays constant.
  const paths = platform === 'win32' ? path.win32 : path.posix
  // os.tmpdir() reads TMPDIR/TMP/TEMP at call time, and a fixture points all
  // three at ITSELF for the run it owns, as does any suite that hands its child
  // an explicit scratch (task-assignment-source.test.mjs:158-160). Reading it
  // straight would nest fixture inside scratch inside fixture. Ask for the
  // PLATFORM temp root with those three scrubbed, so the depth is always 1.
  let base = filesystem.realpathSync.native(platformTempRoot())
  for (let guard = 0; guard < 64; guard += 1) {
    if (!FIXTURE_BASENAME.test(paths.basename(base))) break
    const up = paths.dirname(base)
    if (up === base) break
    base = up
  }
  return inspectSourceFixtureHome(base, { platform, filesystem })
}

// Retention is a WITHIN-RUN contract, not a forever contract. The gate adapters
// (tools/lib/adapters/task-assignment-source.mjs, settings-source-paired.mjs)
// judge the fixture from the transcript's reported path only; they never stat it
// after the child exits. What must survive is the directory for the LIFETIME OF
// THE TEST PROCESS, so the product under test can keep its lifecycle state there
// (TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES / TOOLSENABLED_TEST_RETAIN_FIXTURES).
// Set TOOLSENABLED_TEST_SOURCE_FIXTURE_KEEP=1 to keep it for post-mortem debugging.
export function removeFixtureOnExit(root, { env = process.env, filesystem = fs } = {}) {
  if (env[SOURCE_FIXTURE_KEEP] === '1') return false
  let done = false
  const remove = () => {
    if (done) return
    done = true
    // Success AND failure: 'exit' also runs after an uncaught exception or a
    // failed assertion, so a red suite cleans up exactly like a green one.
    try { filesystem.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
    catch { /* best-effort: never mask the test's own outcome */ }
  }
  process.once('exit', remove)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { remove(); process.kill(process.pid, signal) })
  }
  return true
}

export function prepareRetainedSourceFixture({
  parent = sourceFixtureParent(), cleanup = removeFixtureOnExit,
} = {}) {
  const home = parent
  const root = fs.mkdtempSync(path.join(home, 'te-source-fixture-'))
  const entry = fs.lstatSync(root)
  if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error('Fresh source fixture is not an ordinary directory')
  }
  const environment = retainedSourceFixtureEnvironment(root, home)
  cleanup(root)
  return { root, environment }
}
