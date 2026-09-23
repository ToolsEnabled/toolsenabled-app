param(
    [Parameter(Mandatory=$true)][string]$ProfileRoot,
    [Parameter(Mandatory=$true)][string]$Python,
    [string]$InstallRoot = '',
    [string]$TempRoot = ''
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($ProfileRoot) -or -not [IO.Path]::IsPathRooted($Python)) {
    throw 'ProfileRoot and Python must be explicit absolute paths.'
}
foreach ($voiceExplicitPath in @($InstallRoot, $TempRoot)) {
    if ($voiceExplicitPath -and -not [IO.Path]::IsPathRooted($voiceExplicitPath)) {
        throw 'InstallRoot and TempRoot must be absolute when provided.'
    }
}
if (([IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\').Split('\')).Count -lt 3) {
    throw 'ProfileRoot must identify a specific owner profile.'
}
$voiceAllowedRoot = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\') + '\'
$voiceWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$voiceInstallRoot = if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } else { [IO.Path]::GetFullPath((Join-Path $voiceWorkspace 'deps\voice-runtime')) }
$voiceTempRoot = if ($TempRoot) { [IO.Path]::GetFullPath($TempRoot) } else { Join-Path $voiceAllowedRoot 'AppData\Local\Temp' }
foreach ($voicePath in @($voiceInstallRoot, $voiceTempRoot)) {
    if (-not $voicePath.StartsWith($voiceAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Voice runtime installation must remain inside the explicit owner profile fence.'
    }
    $voiceAncestor = $voicePath
    while ($voiceAncestor.Length -ge ($voiceAllowedRoot.Length - 1)) {
        if (Test-Path -LiteralPath $voiceAncestor) {
            if ((Get-Item -LiteralPath $voiceAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing reparse point in voice runtime path: $voiceAncestor"
            }
        }
        $voiceAncestor = [IO.Path]::GetDirectoryName($voiceAncestor)
    }
}
$voiceInterpreter = [IO.Path]::GetFullPath($Python)
if ($voiceInterpreter -match '^[A-Za-z]:\\Users\\' -and -not $voiceInterpreter.StartsWith($voiceAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Python interpreter is in a different owner profile.'
}
$voiceAncestor = $voiceInterpreter
while ($voiceAncestor) {
    if ((Test-Path -LiteralPath $voiceAncestor) -and ((Get-Item -LiteralPath $voiceAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing a reparse point in the interpreter path.'
    }
    $voiceAncestor = [IO.Path]::GetDirectoryName($voiceAncestor)
}
New-Item -ItemType Directory -Path $voiceInstallRoot -Force | Out-Null
$env:TEMP = $voiceTempRoot
$env:TMP = $voiceTempRoot
$env:PIP_CONFIG_FILE = 'NUL'
$env:PIP_CACHE_DIR = Join-Path $voiceInstallRoot 'pip-cache'
$env:PYTHONNOUSERSITE = '1'
$voicePython = Join-Path $voiceInstallRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $voicePython)) {
    & $Python -I -m venv (Join-Path $voiceInstallRoot 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated voice runtime.' }
}
& $voicePython -I -m pip install --disable-pip-version-check --only-binary=:all: --no-binary=docopt -c (Join-Path $PSScriptRoot 'requirements.lock.txt') -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed.' }
# These distribution names overlap; install GPU module contents last and never
# uninstall either independently. Re-running this script repairs the overlap.
& $voicePython -I -m pip install --disable-pip-version-check --only-binary=:all: --force-reinstall --no-deps 'onnxruntime-gpu==1.24.4'
if ($LASTEXITCODE -ne 0) { throw 'CUDA ONNX Runtime installation failed.' }
Write-Output "Voice runtime Python: $voicePython"

