<#
.SYNOPSIS
  Prove, on real bytes, that an NSIS upgrade does not delete the customer's vault.

.DESCRIPTION
  THE DEFECT THIS EXISTS AGAINST. A build shipped before the state-root
  relocation wrote the customer's vault and signed audit ledger into its own
  install directory. On upgrade, the new installer runs the OLD uninstaller
  first, and app-builder-lib templates/nsis/uninstaller.nsh line 187 is
  `RMDir /r $INSTDIR`. The application-side rescue can never fire, because by
  the time the app's first line runs the directory is gone. build/installer.nsh
  customInit is the only actor standing between the two, and
  templates/nsis/installer.nsi runs it in .onInit AFTER initMultiUser has
  resolved $INSTDIR to the existing install and BEFORE installSection.nsh line
  52 runs uninstallOldVersion.

  tools/test/nsis-upgrade-rescue.test.mjs proves the LOGIC against a faithful
  model. It cannot prove that makensis compiles the macro, that ${PRODUCT_NAME}
  resolves to the folder Electron uses for userData, that the shell-var context
  is `current` at customInit, or that CopyFiles/SHFileOperation really recurses.
  Only a real installer can, and this script is how that is run.

  WHAT IT DOES. Builds two real installers with electron-builder + makensis
  from this tree -- an OLD one whose buildResources directory has no
  installer.nsh (the defective build) and a NEW one using the real build/
  directory -- installs the OLD one, seeds marker bytes into the old layout,
  runs the NEW one as a genuine upgrade, and compares sha256 before and after.

.NOTES
  ISOLATION IS MANDATORY AND ENFORCED BELOW. This installs and uninstalls
  software and writes to HKCU. It runs under a DISTINCT productName, appId and
  nsis.guid so it can never touch the real product's %APPDATA% state root or
  registry keys -- running it under the shipping identity would put the
  operator's own vault behind the `RMDir /r` this script is designed to
  provoke. The guard below refuses that outright.

  Per-user install only (oneClick, perMachine:false): no elevation, no UAC.
#>
param(
  [string]$ProductName = "T1aRescueProbe",
  [string]$Guid        = "7f3a1c92-4b8e-4d21-9c6f-0a5e2d81b437",
  [switch]$KeepBuilds
)
$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# THE ISOLATION GUARD. Absence is not consent here either: an unset or
# real-looking product name must REFUSE, never default to the shipping one.
$REAL_PRODUCT = (Get-Content (Join-Path $PSScriptRoot "..\package.json") -Raw | ConvertFrom-Json).productName
if ([string]::IsNullOrWhiteSpace($ProductName)) {
  Write-Error "REFUSING: -ProductName is empty. This script must run under an isolated identity."; exit 3
}
if ($ProductName -eq $REAL_PRODUCT) {
  Write-Error ("REFUSING: -ProductName is '$ProductName', the SHIPPING product name. This script " +
    "provokes `RMDir /r `$INSTDIR` against a seeded install; running it under the shipping identity " +
    "would aim that at the real %APPDATA%\$REAL_PRODUCT state root -- the operator's own vault. " +
    "Use a distinct name."); exit 3
}
$STATEROOT = Join-Path $env:APPDATA $ProductName
$REGKEY    = "HKCU:\Software\$Guid"
$UNINSTKEY = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Guid"
$REPO      = Resolve-Path (Join-Path $PSScriptRoot "..")
$PROBE     = Join-Path $REPO "release\t1a-roundtrip"

# Fixed marker bytes: reproducible sha256 run to run, and no owner data.
$VAULT  = '{"marker":"NSIS-ROUNDTRIP-VAULT","secret-ref":"REF:vault/probe"}'
$LEDGER = "SQLite format 3`0NSIS-ROUNDTRIP-LEDGER"
$DEEP   = "NSIS-ROUNDTRIP-NESTED"

function Say($m) { Write-Output "[nsis-roundtrip] $m" }
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } else { "ABSENT" } }

function RemoveProbeBuild {
  # This is the only build directory this harness owns. Resolve both sides and
  # refuse a recursive removal if either spelling ever drifts outside the
  # repository's isolated release child.
  $expected = [IO.Path]::GetFullPath((Join-Path ([string]$REPO) "release\t1a-roundtrip"))
  $candidate = [IO.Path]::GetFullPath([string]$PROBE)
  if ($candidate -ne $expected) {
    Say "REFUSING: probe build path '$candidate' is not the expected isolated path '$expected'"
    return $false
  }
  for ($attempt = 1; $attempt -le 10 -and (Test-Path -LiteralPath $candidate); $attempt++) {
    Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $candidate) { Start-Sleep -Milliseconds 500 }
  }
  return -not (Test-Path -LiteralPath $candidate)
}

function Purge {
  $loc = $null
  if (Test-Path $REGKEY) { $loc = (Get-ItemProperty $REGKEY -ErrorAction SilentlyContinue).InstallLocation }
  if ($loc -and (Test-Path $loc)) {
    $un = Get-ChildItem $loc -Filter "Uninstall*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($un) { Start-Process -FilePath $un.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden; Start-Sleep -Milliseconds 2000 }
  }
  foreach ($p in @($loc, $STATEROOT)) { if ($p -and (Test-Path $p)) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue } }
  foreach ($k in @($REGKEY, $UNINSTKEY)) { if (Test-Path $k) { Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue } }
}

function BuildConfig($name, $buildResources, $outDir, $version) {
  $cfg = [ordered]@{
    appId = "com.toolsenabled.nsisroundtrip"; productName = $ProductName
    copyright = "Copyright 2026 ToolsEnabled, Inc."; asar = $true
    electronDist = "node_modules/electron/dist"; compression = "store"
    directories = @{ output = $outDir; buildResources = $buildResources }
    files = @("dist/**", "shell/**", "!tools/**", "!node_modules/**")
    extraResources = @(@{ from = "capability"; to = "capability" })
    win = @{ target = @(@{ target = "nsis"; arch = @("x64") }); icon = "shell/icon.ico"; signExecutable = $false }
    nsis = @{ oneClick = $true; perMachine = $false; guid = $Guid; runAfterFinish = $false
              createDesktopShortcut = $false; createStartMenuShortcut = $false }
    extraMetadata = @{ version = $version; name = "nsisroundtrip" }
  }
  $file = Join-Path $PROBE "$name.json"
  $cfg | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding utf8
  return $file
}

if (-not (RemoveProbeBuild)) {
  Say "REFUSING: the previous isolated probe build could not be removed; stale installers would invalidate this run"
  exit 3
}
New-Item -ItemType Directory -Force -Path (Join-Path $PROBE "build-norescue") | Out-Null
Set-Content -LiteralPath (Join-Path $PROBE "build-norescue\README.txt") -Encoding utf8 `
  -Value "Deliberately holds NO installer.nsh: this models the build that shipped before the rescue existed."

Say "=== building the OLD installer (no rescue hook) and the NEW one (real build/installer.nsh) ==="
Set-Location $REPO
$old = BuildConfig "old" "release/t1a-roundtrip/build-norescue" "release/t1a-roundtrip/out-old" "1.0.5"
$new = BuildConfig "new" "build"                                "release/t1a-roundtrip/out-new" "1.0.6"
foreach ($c in @($old, $new)) {
  & node "node_modules/electron-builder/cli.js" --win nsis --config $c
  if ($LASTEXITCODE -ne 0) { Say "BUILD FAILED for $c (exit $LASTEXITCODE)"; exit 3 }
}
$OLD_EXE = Get-ChildItem (Join-Path $PROBE "out-old") -Filter "*.exe" | Select-Object -First 1
$NEW_EXE = Get-ChildItem (Join-Path $PROBE "out-new") -Filter "*.exe" | Select-Object -First 1
if (-not $OLD_EXE -or -not $NEW_EXE) { Say "REFUSING: an installer is missing after a successful build"; exit 3 }

Say "=== clean slate ==="
Purge
if ((Test-Path $STATEROOT) -or (Test-Path $REGKEY)) { Say "REFUSING: not a clean slate"; exit 3 }

Say "=== install the OLD build, then seed the old-layout runtime state ==="
Start-Process -FilePath $OLD_EXE.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden
Start-Sleep -Milliseconds 2000
if (-not (Test-Path $REGKEY)) { Say "FAIL: the OLD install left no registry key"; exit 3 }
$INSTDIR = (Get-ItemProperty $REGKEY).InstallLocation
$cap = Join-Path $INSTDIR "resources\capability"
New-Item -ItemType Directory -Force -Path (Join-Path $cap "vault"), (Join-Path $cap "state\sub") | Out-Null
[IO.File]::WriteAllText((Join-Path $cap "vault\secrets.json"),  $VAULT)
[IO.File]::WriteAllText((Join-Path $cap "state\audit.sqlite3"), $LEDGER)
[IO.File]::WriteAllText((Join-Path $cap "state\sub\deep.json"), $DEEP)
$seedVault  = Sha (Join-Path $cap "vault\secrets.json")
$seedLedger = Sha (Join-Path $cap "state\audit.sqlite3")
$seedDeep   = Sha (Join-Path $cap "state\sub\deep.json")
Say "INSTDIR=$INSTDIR"
Say "seeded vault sha256=$seedVault"

Say "=== the genuine upgrade ==="
Start-Process -FilePath $NEW_EXE.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden
Start-Sleep -Milliseconds 2500

$instAfter = Sha (Join-Path $cap "vault\secrets.json")
$gotVault  = Sha (Join-Path $STATEROOT "capability\vault\secrets.json")
$gotLedger = Sha (Join-Path $STATEROOT "capability\state\audit.sqlite3")
$gotDeep   = Sha (Join-Path $STATEROOT "capability\state\sub\deep.json")
Say "install-dir vault after upgrade : $instAfter  (ABSENT proves RMDir /r `$INSTDIR ran)"
Say "state-root vault  : $gotVault"
Say "state-root ledger : $gotLedger"
Say "state-root nested : $gotDeep"

$exit = 0
if ($instAfter -ne "ABSENT") {
  Say "INCONCLUSIVE: the old install directory survived, so the defect was never provoked."
  $exit = 4
} elseif ($gotVault -eq $seedVault -and $gotLedger -eq $seedLedger -and $gotDeep -eq $seedDeep) {
  Say "PASS: the vault, the signed ledger and a NESTED file all survived the upgrade byte-identical."
} else {
  Say "FAIL: customer data did NOT survive `RMDir /r `$INSTDIR`. This is the shipping defect."
  $exit = 1
}

Say "=== cleanup ==="
Purge
if (-not $KeepBuilds) { $buildRemoved = RemoveProbeBuild }
$stateResidue = Test-Path $STATEROOT
$regResidue = Test-Path $REGKEY
$buildResidue = Test-Path $PROBE
Say ("residue: stateRoot={0} regKey={1} buildRoot={2}" -f $stateResidue, $regResidue, $buildResidue)
if ($stateResidue -or $regResidue -or ((-not $KeepBuilds) -and $buildResidue)) {
  Say "FAIL: cleanup left probe residue; this run is not a clean release gate"
  if ($exit -eq 0) { $exit = 3 }
}
exit $exit
