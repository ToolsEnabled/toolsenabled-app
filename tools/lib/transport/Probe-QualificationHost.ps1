[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'QualificationVm.psm1') -Force
$status = Get-QualificationHostStatus
$status | ConvertTo-Json -Depth 5
if (-not $status.available) { exit 2 }
