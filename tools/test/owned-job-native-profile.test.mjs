import assert from 'node:assert/strict'
import fs from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { INSTALLER_IDENTITIES, readLifecycleInventory } from '../lib/drivers/installer-lifecycle.mjs'

test('installer contracts derive the owning account and refuse a foreign inventory before reading it', () => {
  const owner = path.win32.normalize(userInfo().homedir)
  for (const identity of Object.values(INSTALLER_IDENTITIES)) {
    assert.ok(identity.installDir.startsWith(owner + '\\'))
    assert.ok(identity.shortcut.startsWith(owner + '\\'))
  }
  if (process.platform === 'win32') {
    const foreign = path.join(path.dirname(userInfo().homedir), 'Foreign-Native-Qualification-Sentinel', 'inventory.json')
    assert.throws(() => readLifecycleInventory(foreign, { product: 'toolsenabled' }), /outside|fence|profile|escap/i)
  }
})

test('the registered installed reader digest matches its reviewed source bytes', () => {
  const source = fs.readFileSync(new URL('../lib/transport/owned-job.mjs', import.meta.url), 'utf8')
  const approved = /const APPROVED_INSTALLED_READER_SHA256 = '([a-f0-9]{64})'/.exec(source)?.[1]
  const actual = createHash('sha256').update(fs.readFileSync(new URL('../lib/guest/Read-InstalledState.ps1', import.meta.url))).digest('hex')
  assert.equal(approved, actual)
})

// Compile and execute the actual native reader/lease code. No product,
// provider, token elevation, installer or qualification job is started.
test('native Windows owned-job paths bind the OS token profile and retain ordinary file handles', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async t => {
  const source = fs.readFileSync(new URL('../lib/transport/owned-job.mjs', import.meta.url), 'utf8')
  const native = /const NATIVE = String.raw`([\s\S]*?)`;/.exec(source)?.[1]
  assert.ok(native && !native.includes('${'), 'exercise the unmodified literal native implementation')
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'owned-job-native-profile-'))
  const owner = userInfo().homedir
  const data = Buffer.from('{}\n')
  fs.writeFileSync(path.join(root, 'native.cs'), native)
  fs.writeFileSync(path.join(root, 'input.json'), data)
  fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({ owner,
    foreign: path.join(path.dirname(owner), 'Foreign-Native-Qualification-Sentinel', 'input.json'),
    sha256: createHash('sha256').update(data).digest('hex') }))
  fs.symlinkSync(root, path.join(root, 'linked-parent'), 'junction')
  const script = String.raw`
param([string]$Fixture)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $Fixture 'native.cs'))) -Language CSharp
$expected=Get-Content -LiteralPath (Join-Path $Fixture 'expected.json') -Raw | ConvertFrom-Json
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$owner=[OwnedJob].GetMethod('OwnerProfile',$flags).Invoke($null,@())
if($owner -ne $expected.owner){throw 'Native token profile differs from OS account'}
$type=[OwnedJob].GetNestedType('PlainLease',[Reflection.BindingFlags]::NonPublic)
$open=$type.GetMethod('ReadLease',[Reflection.BindingFlags]'Static,Public')
$lease=$open.Invoke($null,[object[]]@([string](Join-Path $Fixture 'input.json')))
try {
  $digest=$type.GetMethod('Seal').Invoke($lease,[object[]]@([long]3))
  if($digest -ne $expected.sha256){throw 'Native retained-handle file identity differs'}
} finally { ([IDisposable]$lease).Dispose() }
foreach($case in @(
  @{path=$expected.foreign;reason='leased path leaves current OS account fence'},
  @{path=(Join-Path $Fixture 'linked-parent\input.json');reason='leased path is linked or not ordinary'}
)) {
  $refused=$false
  try { $unexpected=$open.Invoke($null,[object[]]@([string]$case.path)); ([IDisposable]$unexpected).Dispose() }
  catch { if($_.Exception.ToString().Contains($case.reason)){$refused=$true}else{throw} }
  if(-not $refused){throw 'Unsafe native path was not refused'}
}
Write-Output 'NATIVE_OWNER_PROFILE_AND_LEASE_OK'
`
  const scriptPath = path.join(root, 'proof.ps1')
  fs.writeFileSync(scriptPath, script)
  const result = spawnSync(String.raw`\\.\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, root], {
      cwd: root, env: { ...process.env, TEMP: root, TMP: root }, windowsHide: true,
      encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    })
  if (result.error || result.signal) {
    t.diagnostic('Native proof scratch retained because process completion is unconfirmed: ' + root)
    throw result.error || new Error('Native proof process did not close normally')
  }
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /NATIVE_OWNER_PROFILE_AND_LEASE_OK/)
  } finally {
    // Remove only this fixture's link, then its confirmed-closed workspace.
    fs.unlinkSync(path.join(root, 'linked-parent'))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// Exercise the actual reader's private path primitive, never Measure(): the
// installed application, registry and Start Menu are outside this test's scope.
test('native installed reader and VM authority use the OS token before path access', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async t => {
  const reader = fs.readFileSync(new URL('../lib/guest/Read-InstalledState.ps1', import.meta.url), 'utf8')
  const native = /\$installedStateNative = @'\r?\n([\s\S]*?)\r?\n'@/.exec(reader)?.[1]
  assert.ok(native, 'compile the actual reader implementation')
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'native-account-authority-'))
  const owner = userInfo().homedir
  fs.writeFileSync(path.join(root, 'reader.cs'), native)
  fs.writeFileSync(path.join(root, 'input.json'), '{}\n')
  fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({ owner,
    foreign: path.join(path.dirname(owner), 'Foreign-Native-Qualification-Sentinel', 'input.json'),
    modulePath: fileURLToPath(new URL('../lib/transport/QualificationVm.psm1', import.meta.url)),
  }))
  fs.symlinkSync(root, path.join(root, 'linked-parent'), 'junction')
  const script = String.raw`
param([string]$Fixture)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$expected=Get-Content -LiteralPath (Join-Path $Fixture 'expected.json') -Raw | ConvertFrom-Json
# An inherited/caller profile string is not account authority.
$env:USERPROFILE=[IO.Path]::GetDirectoryName($expected.foreign)
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $Fixture 'reader.cs'))) -Language CSharp
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$owner=[InstalledStateNative].GetMethod('OwnerProfile',$flags).Invoke($null,@())
if($owner -ne $expected.owner){throw 'Reader trusted an environment profile instead of the token'}
$open=[InstalledStateNative].GetMethod('OpenPlain',$flags)
$lease=$open.Invoke($null,[object[]]@([string](Join-Path $Fixture 'input.json'),$false,$true))
([IDisposable]$lease).Dispose()
foreach($case in @(
  @{path=$expected.foreign;reason='outside-profile-fence'},
  @{path=(Join-Path $Fixture 'linked-parent\input.json');reason='reparse-point'}
)) {
  $refused=$false
  try { $unexpected=$open.Invoke($null,[object[]]@([string]$case.path,$false,$true)); ([IDisposable]$unexpected).Dispose() }
  catch { if($_.Exception.ToString().Contains($case.reason)){$refused=$true}else{throw} }
  if(-not $refused){throw 'Reader accepted a foreign or linked path'}
}
$module=Import-Module -Name $expected.modulePath -Force -PassThru
$account=& $module { Assert-QualificationCurrentAccount }
if($account.profile -ne $expected.owner){throw 'VM authority trusted an environment profile instead of the token'}
$null=Assert-QualificationPath -Path (Join-Path $Fixture 'input.json')
$config=[pscustomobject]@{schema='toolsenabled.hyperv-qualification-worker';schemaVersion=1;
  vmName='ToolsEnabled-Qualification-Synthetic';vmId=[Guid]::NewGuid().ToString();baselineCheckpointId=[Guid]::NewGuid().ToString();
  machineRoot=$Fixture;guestProfile=$account.profile;networkPolicy='offline'}
$null=Assert-QualificationVmConfig -Config $config
$secret=ConvertTo-SecureString 'synthetic-unused-credential' -AsPlainText -Force
$credential=[PSCredential]::new($account.userName,$secret)
$null=& $module { param($value) Assert-QualificationCredential $value } $credential
foreach($case in @('foreign-path','linked-path','foreign-guest-profile','foreign-credential')) {
  $refused=$false
  try {
    switch($case) {
      'foreign-path' { $null=Assert-QualificationPath -Path $expected.foreign }
      'linked-path' { $null=Assert-QualificationPath -Path (Join-Path $Fixture 'linked-parent\input.json') }
      'foreign-guest-profile' { $config.guestProfile=[IO.Path]::GetDirectoryName($expected.foreign); $null=Assert-QualificationVmConfig -Config $config }
      'foreign-credential' { $credential=[PSCredential]::new('Foreign-Native-Qualification-Sentinel',$secret); $null=& $module { param($value) Assert-QualificationCredential $value } $credential }
    }
  } catch {
    $message=$_.Exception.ToString()
    $reason=switch($case) {
      'foreign-path' {'leaves the current OS account profile'}
      'linked-path' {'reparse point'}
      'foreign-guest-profile' {'differs from the captured owning account profile'}
      'foreign-credential' {'must name the current owning account'}
    }
    if($message.Contains($reason)){$refused=$true}else{throw}
  }
  if(-not $refused){throw ('VM boundary accepted '+$case)}
}
# Synthetic host observations exercise the actual status function. Identity and
# administrator membership still come from the real current Windows token.
# These stubs cannot execute, authorize, or attest any VM.
& $module {
  $script:FixtureHypervisor=$true
  $script:FixtureFirmware=$false
  $script:FixtureMissingCommand=''
  function script:Get-CimInstance {
    param([string]$ClassName)
    switch($ClassName) {
      'Win32_ComputerSystem' { [pscustomobject]@{HypervisorPresent=$script:FixtureHypervisor} }
      'Win32_Processor' { [pscustomobject]@{VirtualizationFirmwareEnabled=$script:FixtureFirmware} }
      'Win32_OperatingSystem' { [pscustomobject]@{BuildNumber='synthetic-host-status'} }
      default { throw 'Unexpected synthetic CIM request' }
    }
  }
  function script:Get-Command {
    param([string]$Name,[string]$ErrorAction)
    if($Name -ne $script:FixtureMissingCommand){[pscustomobject]@{Name=$Name}}
  }
}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$active=Get-QualificationHostStatus
if(-not $active.hypervisorPresent -or $active.blockers -match 'Firmware virtualization|No active hypervisor'){throw 'Active hypervisor was contradicted by masked firmware flags'}
if($active.ownerSid -ne $account.sid -or $active.ownerProfile -ne $account.profile){throw 'Host status lost native account authority'}
if($active.available -ne $administrator){throw 'Host status did not preserve actual administrator admission'}
if(-not $administrator -and -not ($active.blockers -match 'administrator token')){throw 'Standard token was treated as authorized VM management'}
& $module {$script:FixtureMissingCommand='Get-VM'}
$missing=Get-QualificationHostStatus
if($missing.available -or -not ($missing.blockers -contains 'Required Hyper-V command is unavailable: Get-VM')){throw 'Missing management command was ignored'}
& $module {$script:FixtureMissingCommand=''; $script:FixtureHypervisor=$false}
$absent=Get-QualificationHostStatus
if($absent.available -or -not ($absent.blockers -contains 'No active hypervisor is reported by this host.') -or
    -not ($absent.blockers -contains 'Firmware virtualization is not reported enabled.')){throw 'Absent hypervisor/firmware refusal was lost'}
& $module {$script:FixtureFirmware=$true}
$firmwareOnly=Get-QualificationHostStatus
if($firmwareOnly.available -or -not ($firmwareOnly.blockers -contains 'No active hypervisor is reported by this host.')){throw 'Firmware flag alone was treated as an active hypervisor'}
Write-Output 'NATIVE_READER_AND_VM_ACCOUNT_AUTHORITY_OK'
`
  const scriptPath = path.join(root, 'proof.ps1')
  fs.writeFileSync(scriptPath, script)
  const result = spawnSync(String.raw`\\.\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, root], {
      cwd: root, env: { ...process.env, TEMP: root, TMP: root }, windowsHide: true,
      encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    })
  if (result.error || result.signal) {
    t.diagnostic('Native account test scratch retained because completion is unconfirmed: ' + root)
    throw result.error || new Error('Native account test did not close normally')
  }
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /NATIVE_READER_AND_VM_ACCOUNT_AUTHORITY_OK/)
  } finally {
    fs.unlinkSync(path.join(root, 'linked-parent'))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
