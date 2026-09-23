Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Both sides measure their OS token. The host's captured owner is the fixed
# expectation; neither USERPROFILE nor the request/configuration selects one.
$script:AccountSource = @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Security.Principal;
using System.Runtime.InteropServices;
public static class QualificationAccountNative {
    public sealed class Account { public string profile, name, userName, sid; }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder directory, ref uint size);
    public static Account Capture() {
        using(var owner=WindowsIdentity.GetCurrent()) {
            uint size=32768; var directory=new StringBuilder((int)size);
            if(!GetUserProfileDirectory(owner.Token,directory,ref size)) throw new Exception("Cannot measure current OS account profile.");
            string profile=directory.ToString();
            if(profile.Length<4 || profile[1]!=':' || profile[2]!='\\' ||
                !Path.GetFullPath(profile).Equals(profile,StringComparison.OrdinalIgnoreCase) ||
                profile.Substring(3).Split('\\').Any(p=>p.Length==0 || p=="." || p==".." || p.EndsWith(".") || p.EndsWith(" ") || p.IndexOfAny(new char[]{':','/','\0','*','?'})>=0))
                throw new Exception("Current OS account profile is not an ordinary absolute path.");
            return new Account { profile=profile, name=owner.Name, userName=owner.Name.Substring(owner.Name.LastIndexOf('\\')+1), sid=owner.User.Value };
        }
    }
}
'@
Add-Type -TypeDefinition $script:AccountSource
$script:OwnerAccount = [QualificationAccountNative]::Capture()
$script:DevProfile = $script:OwnerAccount.profile
$script:VmOwnership = 'ToolsEnabled:disposable-qualification:v1'
$script:EgressHostVectors = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'qualification-egress-host-vectors.json') -Raw | ConvertFrom-Json

function Test-QualificationEgressHost {
    param([string]$Endpoint)
    return $Endpoint -is [string] -and $Endpoint.Length -le 253 -and $Endpoint -match '^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'
}
foreach ($endpoint in @($script:EgressHostVectors.valid)) { if (-not (Test-QualificationEgressHost $endpoint)) { throw 'Egress host validator drifted from shared vectors.' } }
foreach ($endpoint in @($script:EgressHostVectors.invalid)) { if (Test-QualificationEgressHost $endpoint) { throw 'Egress host validator drifted from shared vectors.' } }

function Assert-QualificationCurrentAccount {
    $current = [QualificationAccountNative]::Capture()
    if ($current.sid -ne $script:OwnerAccount.sid -or $current.name -ne $script:OwnerAccount.name -or $current.profile -ne $script:DevProfile) {
        throw 'Current OS account changed after qualification authority was captured.'
    }
    return $current
}

function Assert-QualificationCredential {
    param([Parameter(Mandatory)][PSCredential]$Credential)
    $owner = Assert-QualificationCurrentAccount
    if ($Credential.UserName -notmatch ('^(?:[^\\]+\\)?' + [Regex]::Escape($owner.userName) + '$')) {
        throw 'Guest credential must name the current owning account; no alternate account fallback.'
    }
}

function Assert-QualificationPath {
    param([Parameter(Mandatory)][string]$Path, [ValidateSet('File','Directory')][string]$Kind = 'File')
    $null = Assert-QualificationCurrentAccount
    if ($Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '[\\/][^\\/]*[ .]([\\/]|$)') {
        throw 'Qualification path must use an explicit, unambiguous local drive path.'
    }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($script:DevProfile + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Qualification path leaves the current OS account profile.'
    }
    $cursor = $script:DevProfile
    $profileEntry = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (-not $profileEntry.PSIsContainer -or ($profileEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Qualification profile root is not a plain directory.' }
    foreach ($part in $resolved.Substring($script:DevProfile.Length + 1).Split('\')) {
        $cursor = [IO.Path]::Combine($cursor, $part)
        $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Qualification path contains a reparse point.' }
        if ($cursor -ne $resolved -and -not $entry.PSIsContainer) { throw 'Qualification parent is not a directory.' }
    }
    if (($Kind -eq 'Directory') -ne [bool]$entry.PSIsContainer) { throw "Qualification input is not a $Kind." }
    return $resolved
}

function Test-PathWithin {
    param([string]$Root, [string]$Path)
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-QualificationHostStatus {
    $owner = Assert-QualificationCurrentAccount
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $processor = @(Get-CimInstance -ClassName Win32_Processor)
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $blockers = [Collections.Generic.List[string]]::new()
    if (-not $computer.HypervisorPresent) { $blockers.Add('No active hypervisor is reported by this host.') }
    # Windows suppresses the raw hardware requirements once a hypervisor is
    # detected; a masked firmware flag must not contradict that observation.
    # https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements#final-check
    # Management/token admission and actual VM/baseline verification still apply.
    if (-not $computer.HypervisorPresent -and @($processor | Where-Object { -not $_.VirtualizationFirmwareEnabled }).Count) {
        $blockers.Add('Firmware virtualization is not reported enabled.')
    }
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $blockers.Add('Hyper-V management requires the chosen authorized administrator token.') }
    if ($identity.User.Value -ne $owner.sid) { $blockers.Add('The current account changed during host observation.') }
    foreach ($name in @('Get-VM','Get-VHD','Restore-VMSnapshot','Start-VM','Stop-VM','Copy-VMFile')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { $blockers.Add("Required Hyper-V command is unavailable: $name") }
    }
    return [pscustomobject]@{ schema = 'toolsenabled.qualification-host-status'; schemaVersion = 1;
        measuredAt = [DateTime]::UtcNow.ToString('o'); osBuild = [string]$os.BuildNumber;
        ownerAccount = $owner.name; ownerSid = $owner.sid; ownerProfile = $owner.profile;
        hypervisorPresent = [bool]$computer.HypervisorPresent; blockers = @($blockers.ToArray()); available = ($blockers.Count -eq 0) }
}

function Assert-QualificationVmConfig {
    param([Parameter(Mandatory)]$Config)
    $null = Assert-QualificationCurrentAccount
    $allowed = @('schema','schemaVersion','vmId','vmName','baselineCheckpointId','machineRoot','guestProfile','networkPolicy','allowedEndpoints','egressSwitchName')
    if ($Config.schema -ne 'toolsenabled.hyperv-qualification-worker' -or $Config.schemaVersion -ne 1 -or
        @($Config.PSObject.Properties.Name | Where-Object { $_ -notin $allowed }).Count) { throw 'Unknown or incomplete qualification VM configuration.' }
    if ($Config.vmName -notmatch '^ToolsEnabled-Qualification-[a-zA-Z0-9-]+$' -or
        $Config.vmId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' -or
        $Config.baselineCheckpointId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'A dedicated qualification VM and exact baseline checkpoint IDs are required.' }
    if ($Config.guestProfile -ne $script:DevProfile) { throw 'Guest profile expectation differs from the captured owning account profile.' }
    if ($Config.networkPolicy -notin @('offline','allow-list')) { throw 'networkPolicy must be offline or allow-list.' }
    $hasEndpoints = $null -ne $Config.PSObject.Properties['allowedEndpoints']
    $hasSwitch = $null -ne $Config.PSObject.Properties['egressSwitchName']
    $endpoints = if ($hasEndpoints) { @($Config.allowedEndpoints) } else { @() }
    if ($Config.networkPolicy -eq 'offline' -and ((@($endpoints).Count -gt 0) -or ($hasSwitch -and $Config.egressSwitchName))) { throw 'Offline qualification cannot carry an egress allow-list.' }
    if ($Config.networkPolicy -eq 'allow-list') {
        if ((@($endpoints).Count -lt 1) -or (@($endpoints).Count -gt 32)) { throw 'An allow-list qualification requires 1 to 32 explicit endpoints.' }
        foreach ($endpoint in $endpoints) {
            if (-not (Test-QualificationEgressHost $endpoint)) { throw 'Egress allow-list entries must be explicit endpoint names; wildcards, CIDR and malformed schemes are refused.' }
        }
        if (-not $hasSwitch -or $Config.egressSwitchName -notmatch '^ToolsEnabled-Qualification-Egress-[a-zA-Z0-9-]+$') { throw 'An allow-list declaration requires its dedicated named egress switch.' }
    } elseif ($hasSwitch -and $Config.egressSwitchName) { throw 'An egress switch is only valid with networkPolicy allow-list.' }
    $null = Assert-QualificationPath $Config.machineRoot -Kind Directory
    return $Config
}

function Assert-QualificationEgressControl {
    param([Parameter(Mandatory)]$Config)
    if ($Config.networkPolicy -eq 'offline') { return }
    if ($Config.networkPolicy -ne 'allow-list') { throw 'QUALIFICATION_EGRESS_UNPROVEN: unknown network policy; refusing to run.' }
    if ([string]$Config.egressSwitchName -notmatch '^ToolsEnabled-Qualification-Egress-[a-zA-Z0-9-]+$' -or
        [string]$Config.egressSwitchName -match '[*?\[\]]') { throw 'QUALIFICATION_EGRESS_UNPROVEN: switch name must be one exact dedicated name; wildcards are refused.' }
    $switches = @(Get-VMSwitch -Name $Config.egressSwitchName -ErrorAction SilentlyContinue)
    $switch = @($switches | Where-Object { $_.Name -ceq [string]$Config.egressSwitchName }) | Select-Object -First 1
    if (-not $switch) { throw 'QUALIFICATION_EGRESS_UNPROVEN: dedicated switch cannot be inspected; refusing to run under a reassuring name.' }
    if ($switch.SwitchType -ne 'Private') { throw "QUALIFICATION_EGRESS_UNPROVEN: named switch '$($Config.egressSwitchName)' is not Private; observed type '$($switch.SwitchType)' is refused." }
    if ([bool]$switch.AllowManagementOS) { throw "QUALIFICATION_EGRESS_UNPROVEN: named switch '$($Config.egressSwitchName)' permits host management; guest-plane egress is unproven." }
    try { $vmGuid = [Guid]$Config.vmId } catch { throw 'QUALIFICATION_EGRESS_UNPROVEN: VM id is not a valid GUID; refusing to run.' }
    $targetVm = Get-VM -Id $vmGuid -ErrorAction SilentlyContinue
    $adapters = @()
    if ($targetVm) { $adapters = @(Get-VMNetworkAdapter -VM $targetVm -ErrorAction SilentlyContinue | Where-Object { $_.SwitchName -ceq [string]$Config.egressSwitchName }) }
    if (-not @($adapters).Count) { throw 'QUALIFICATION_EGRESS_UNPROVEN: the dedicated VM has no adapter on the named switch; guest-plane ACL proof is absent.' }
    foreach ($adapter in $adapters) {
        $acls = @(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $adapter -ErrorAction SilentlyContinue)
        $allows = @($acls | Where-Object { $_.Direction -eq 'Outbound' -and $_.Action -eq 'Allow' })
        if (@($allows).Count) { throw 'QUALIFICATION_EGRESS_UNPROVEN: outbound Allow extended ACL exists on the dedicated adapter; refusing to run.' }
        $denyAllOutbound = @($acls | Where-Object {
            $_.Direction -eq 'Outbound' -and $_.Action -eq 'Deny' -and
            ([string]$_.LocalIPAddress -in @('', 'Any', '*')) -and
            ([string]$_.RemoteIPAddress -in @('', 'Any', '*'))
        })
        if (-not @($denyAllOutbound).Count) { throw 'QUALIFICATION_EGRESS_UNPROVEN: the dedicated VM adapter lacks an outbound deny-all port ACL; guest-plane egress is unproven.' }
    }
    # A Private switch has no host vEthernet adapter by design. The adapter ACL
    # above is the guest-plane proof; host firewall rules are intentionally not
    # treated as evidence for guest traffic.
}

function Assert-QualificationDiskChain {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    while ($Path) {
        $Path = Assert-QualificationPath $Path
        if (-not (Test-PathWithin $Root $Path)) { throw 'VM disk chain leaves its dedicated machine directory.' }
        if (-not $seen.Add($Path) -or $seen.Count -gt 32) { throw 'VM disk parent chain is cyclic or exceeds its bound.' }
        # Metadata inspection only: never mount or enumerate a guest filesystem.
        # Fence each explicit parent path before querying the next disk.
        $disk = Get-VHD -Path $Path -ErrorAction Stop
        if ($disk.Attached) { throw 'Qualification will not reuse a host-mounted virtual disk.' }
        $Path = [string]$disk.ParentPath
    }
}

function Get-QualificationVm {
    param([Parameter(Mandatory)]$Config)
    $null = Assert-QualificationVmConfig $Config
    Assert-QualificationEgressControl $Config
    $vm = Get-VM -Id ([Guid]$Config.vmId) -ErrorAction Stop
    if ($vm.Name -ne $Config.vmName -or $vm.Notes -ne $script:VmOwnership) { throw 'VM identity or dedicated ownership marker differs; no VM may be modified.' }
    foreach ($location in @($vm.Path, $vm.SnapshotFileLocation, $vm.SmartPagingFilePath)) {
        $resolved = Assert-QualificationPath ([string]$location) -Kind Directory
        if (-not (Test-PathWithin $Config.machineRoot $resolved)) { throw 'VM configuration or paging storage leaves its dedicated directory.' }
    }
    $adapters = @(Get-VMNetworkAdapter -VM $vm | Where-Object { $_.SwitchId -and [Guid]$_.SwitchId -ne [Guid]::Empty })
    if ($Config.networkPolicy -eq 'offline' -and $adapters.Count) { throw 'Offline qualification refuses a VM connected to a virtual switch.' }
    if ($Config.networkPolicy -eq 'allow-list' -and @($adapters | Where-Object { $_.SwitchName -ne $Config.egressSwitchName }).Count) { throw 'Allow-list qualification refuses a VM connected to any switch except its dedicated egress switch.' }
    # -Id is its OWN parameter set on the Hyper-V module: it does not combine
    # with -VM. Passing both binds to nothing and throws "Parameter set cannot
    # be resolved" before a single contract check is reached, so the whole
    # qualification path is unreachable on a host that ships this module.
    # Nothing is lost by dropping -VM: the next line already refuses a snapshot
    # whose VMId is not this VM's, which is the check -VM was standing in for.
    $snapshot = Get-VMSnapshot -Id ([Guid]$Config.baselineCheckpointId) -ErrorAction Stop
    if (-not $snapshot -or $snapshot.VMId -ne $vm.Id) { throw 'The exact baseline checkpoint does not belong to this VM.' }
    if ([string]$snapshot.State -ne 'Off') { throw 'The baseline must be a powered-off checkpoint, not a saved running session.' }
    $snapshotAdapters = @(Get-VMNetworkAdapter -VMSnapshot $snapshot | Where-Object { $_.SwitchId -and [Guid]$_.SwitchId -ne [Guid]::Empty })
    if ($Config.networkPolicy -eq 'offline' -and $snapshotAdapters.Count) { throw 'Offline qualification refuses a baseline connected to a virtual switch.' }
    if ($Config.networkPolicy -eq 'allow-list' -and @($snapshotAdapters | Where-Object { $_.SwitchName -ne $Config.egressSwitchName }).Count) { throw 'Allow-list qualification refuses a baseline connected to any switch except its dedicated egress switch.' }
    if (@(@(Get-VMDvdDrive -VM $vm) + @(Get-VMDvdDrive -VMSnapshot $snapshot) | Where-Object { $_.Path }).Count) { throw 'Qualification refuses current or baseline DVD/ISO attachments; no external image path is followed.' }
    foreach ($disk in @((Get-VMHardDiskDrive -VM $vm)) + @((Get-VMHardDiskDrive -VMSnapshot $snapshot))) {
        if (-not $disk.Path) { throw 'Pass-through or unidentified disks are not valid qualification storage.' }
        Assert-QualificationDiskChain -Path $disk.Path -Root $Config.machineRoot
    }
    return [pscustomobject]@{ VM = $vm; Snapshot = $snapshot }
}

function Wait-QualificationJob {
    param([Parameter(Mandatory)]$Job, [int]$TimeoutSeconds = 120)
    $finished = Wait-Job -Job $Job -Timeout $TimeoutSeconds
    if (-not $finished) {
        # Stopping a PowerShell job does NOT prove the Hyper-V operation stopped.
        # The caller keeps the VM lease quarantined after any such uncertainty.
        throw 'QUALIFICATION_OPERATION_UNCONFIRMED: Hyper-V operation timed out; lease must remain quarantined.'
    }
    if ([string]$Job.State -ne 'Completed') { throw "QUALIFICATION_OPERATION_UNCONFIRMED: Hyper-V job ended in $($Job.State)." }
    return Receive-Job -Job $Job -ErrorAction Stop
}

function Write-QualificationEvent {
    param([IO.FileStream]$Handle, $Event)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Event | ConvertTo-Json -Depth 12 -Compress) + "`n")
    $Handle.Write($bytes, 0, $bytes.Length)
    $Handle.Flush($true)
}

function Invoke-QualificationVmRun {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][PSCredential]$Credential,
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$GuestScript,
        [Parameter(Mandatory)][string]$RequestFile,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$InputFiles,
        [Parameter(Mandatory)][ValidateSet('windows-x64-standard','windows-x64-administrator')][string]$Profile,
        [ValidateRange(1,3600)][int]$TimeoutSeconds = 900
    )
    # General execution transport only; this API never grants release readiness.
    # The registered product driver chooses the script and verifies its report.
    $hostStatus = Get-QualificationHostStatus
    if (-not $hostStatus.available) { throw ('Qualification host unavailable: ' + ($hostStatus.blockers -join ' ')) }
    $null = Assert-QualificationVmConfig $Config
    $null = Assert-QualificationCredential $Credential
    $EvidenceRoot = Assert-QualificationPath $EvidenceRoot -Kind Directory
    if (Test-PathWithin $Config.machineRoot $EvidenceRoot) { throw 'Evidence must survive outside the disposable VM storage tree.' }
    $GuestScript = Assert-QualificationPath $GuestScript
    $RequestFile = Assert-QualificationPath $RequestFile
    $files = @([pscustomobject]@{source=$GuestScript;target='driver.ps1'}, [pscustomobject]@{source=$RequestFile;target='request.json'}) + $InputFiles
    $targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null = $targets.Add('result.json')
    foreach ($file in $files) {
        $file.source = Assert-QualificationPath $file.source
        if ($file.target -notmatch '^[a-zA-Z0-9_-]+([\\/][a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9]+$' -or $file.target -match '(^|[\\/])\.\.?([\\/]|$)' -or -not $targets.Add($file.target.Replace('/', '\'))) { throw 'Guest input target is duplicated or not a bounded relative file.' }
    }
    $machine = Get-QualificationVm $Config
    if ([string]$machine.VM.State -ne 'Off') { throw 'Qualification never takes over a running or saved VM.' }
    $runId = [Guid]::NewGuid().ToString()
    $guestRoot = $script:DevProfile + '\AppData\Local\Temp\qualification-' + $runId
    # Lock location comes from the actual VM, not the caller's evidence path.
    # Selecting a different report directory cannot bypass an uncertain run.
    $leasePath = [IO.Path]::Combine([string]$machine.VM.Path, 'qualification-' + $Config.vmId + '.lease.jsonl')
    $lease = [IO.File]::Open($leasePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $jobs = [Collections.Generic.List[object]]::new()
    $uncertain = $false; $cleanupConfirmed = $false; $beganMutation = $false; $pendingOperation = $false; $result = $null; $caught = $null
    $startedAt = [DateTime]::UtcNow.ToString('o')
    try {
        Write-QualificationEvent $lease @{event='armed';runId=$runId;vmId=$Config.vmId;profile=$Profile;at=$startedAt;ownerPid=$PID}
        $beganMutation = $true
        $pendingOperation = $true
        $job = Restore-VMSnapshot -VMSnapshot $machine.Snapshot -Confirm:$false -AsJob; $jobs.Add($job)
        $null = Wait-QualificationJob $job 120
        $pendingOperation = $false
        $machine = Get-QualificationVm $Config
        if ([string]$machine.VM.State -ne 'Off') { throw 'Restored baseline is not powered off before the controlled launch.' }
        $pendingOperation = $true
        $job = Start-VM -VM $machine.VM -AsJob; $jobs.Add($job)
        $null = Wait-QualificationJob $job 120
        $pendingOperation = $false
        Write-QualificationEvent $lease @{event='started';runId=$runId;at=[DateTime]::UtcNow.ToString('o')}
        # Attest the remote account BEFORE copying or executing any guest input.
        $pendingOperation = $true
        $job = Invoke-Command -VMId ([Guid]$Config.vmId) -Credential $Credential -AsJob -ArgumentList $guestRoot, $script:AccountSource, $script:OwnerAccount.profile, $script:OwnerAccount.userName -ScriptBlock {
            param($runRoot,$accountSource,$expectedProfile,$expectedUserName)
            $ErrorActionPreference = 'Stop'
            Add-Type -TypeDefinition $accountSource
            $identity = [QualificationAccountNative]::Capture()
            if ($identity.userName -ne $expectedUserName -or $identity.profile -ne $expectedProfile) { throw 'Guest native account/profile differs from the captured owner expectation.' }
            $cursor = $identity.profile
            $entry = Get-Item -LiteralPath $cursor -Force
            if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest profile root is not a plain directory.' }
            foreach ($part in @('AppData','Local','Temp')) {
                $cursor = [IO.Path]::Combine($cursor,$part)
                $entry = Get-Item -LiteralPath $cursor -Force
                if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest input parent is not a plain directory.' }
            }
            if ([IO.Path]::GetDirectoryName($runRoot) -ne $cursor -or [IO.Path]::GetFileName($runRoot) -notmatch '^qualification-[a-f0-9-]{36}$') { throw 'Guest run directory is invalid.' }
            $null = New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop
            [pscustomobject]@{account=$identity.name;userName=$identity.userName;sid=$identity.sid;profile=$identity.profile;osBuild=[Environment]::OSVersion.Version.Build;computer=$env:COMPUTERNAME}
        }; $jobs.Add($job)
        $guestIdentity = Wait-QualificationJob $job 120
        $pendingOperation = $false
        foreach ($file in $files) {
            $before = (Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash
            $pendingOperation = $true
            $job = Copy-VMFile -VM $machine.VM -SourcePath $file.source -DestinationPath ([IO.Path]::Combine($guestRoot, $file.target)) -FileSource Host -CreateFullPath -AsJob
            $jobs.Add($job); $null = Wait-QualificationJob $job 120
            $pendingOperation = $false
            if ((Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash -ne $before) { throw 'A guest input changed during transfer.' }
            $file | Add-Member -NotePropertyName sha256 -NotePropertyValue $before -Force
        }
        $pendingOperation = $true
        $job = Invoke-Command -VMId ([Guid]$Config.vmId) -Credential $Credential -AsJob -ArgumentList $guestRoot, @($files | Select-Object target, sha256), $Profile, $script:AccountSource, $guestIdentity -ScriptBlock {
            param($root,$files,$requestedProfile,$accountSource,$expectedAccount)
            $ErrorActionPreference = 'Stop'
            $ProgressPreference = 'SilentlyContinue'
            Add-Type -TypeDefinition $accountSource
            $identity = [QualificationAccountNative]::Capture()
            if ($identity.sid -ne $expectedAccount.sid -or $identity.name -ne $expectedAccount.account -or $identity.profile -ne $expectedAccount.profile) { throw 'Guest native account changed before execution.' }
            if ([IO.Path]::GetDirectoryName($root) -ne [IO.Path]::Combine($identity.profile,'AppData\Local\Temp') -or [IO.Path]::GetFileName($root) -notmatch '^qualification-[a-f0-9-]{36}$') { throw 'Guest path fence refused execution.' }
            foreach ($file in $files) {
                $target = [IO.Path]::Combine($root, $file.target)
                $cursor = $identity.profile
                foreach ($part in $target.Substring($cursor.Length + 1).Split('\')) {
                    $cursor = [IO.Path]::Combine($cursor,$part)
                    if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest input contains a reparse point.' }
                }
                if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Guest transfer hash differs from the host input.' }
            }
            $resultFile = [IO.Path]::Combine($root,'result.json')
            if (Test-Path -LiteralPath $resultFile) { throw 'Guest result already exists before driver execution.' }
            # Drivers retain their own bounded raw streams. Do not let arbitrary
            # console output accumulate in the remoting job's output buffer.
            $LASTEXITCODE = 0
            & ([IO.Path]::Combine($root,'driver.ps1')) -RequestPath ([IO.Path]::Combine($root,'request.json')) -ResultPath $resultFile -Profile $requestedProfile *> $null
            $driverSucceeded = $?
            $driverExit = $LASTEXITCODE
            if (-not $driverSucceeded -or $driverExit -ne 0) { throw 'Guest driver failed; a result file cannot override its exit status.' }
            $after = [QualificationAccountNative]::Capture()
            if ($after.sid -ne $identity.sid -or $after.name -ne $identity.name -or $after.profile -ne $identity.profile) { throw 'Guest native account changed before report measurement.' }
            $cursor = $identity.profile
            foreach ($part in $resultFile.Substring($cursor.Length + 1).Split('\')) {
                $cursor = [IO.Path]::Combine($cursor,$part)
                $entry = Get-Item -LiteralPath $cursor -Force
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest report path contains a reparse point.' }
            }
            if ($entry.PSIsContainer) { throw 'Guest report is not a file.' }
            $handle = [IO.File]::Open($resultFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try {
                if ($handle.Length -gt 2097152 -or $handle.Length -eq 0) { throw 'Guest report is empty or oversized.' }
                $bytes = [byte[]]::new([int]$handle.Length)
                $offset = 0
                while ($offset -lt $bytes.Length) {
                    $count = $handle.Read($bytes,$offset,$bytes.Length-$offset)
                    if ($count -eq 0) { throw 'Guest report changed while being read.' }
                    $offset += $count
                }
                if ($handle.ReadByte() -ne -1) { throw 'Guest report grew while being read.' }
                return [Convert]::ToBase64String($bytes)
            } finally { $handle.Dispose() }
        }; $jobs.Add($job)
        $encoded = Wait-QualificationJob $job $TimeoutSeconds
        $pendingOperation = $false
        if ($encoded -isnot [string]) { throw 'Guest driver mixed report output with unstructured output.' }
        $bytes = [Convert]::FromBase64String($encoded)
        if ($bytes.Length -eq 0 -or $bytes.Length -gt 2097152) { throw 'Guest report exceeds its size budget.' }
        $null = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        $reportPath = [IO.Path]::Combine($EvidenceRoot, 'guest-' + $runId + '.json')
        $report = [IO.File]::Open($reportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { $report.Write($bytes,0,$bytes.Length); $report.Flush($true) } finally { $report.Dispose() }
        $result = [pscustomobject]@{schema='toolsenabled.qualification-vm-execution';schemaVersion=1;runId=$runId;
            scope='vm-transport-only';vmId=$Config.vmId;baselineCheckpointId=$Config.baselineCheckpointId;requestedProfile=$Profile;
            guestIdentity=$guestIdentity;startedAt=$startedAt;reportPath=$reportPath;reportSha256=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash}
    } catch {
        $caught = $_
        if ($pendingOperation -or $_.Exception.Message -match 'QUALIFICATION_OPERATION_UNCONFIRMED') { $uncertain = $true }
        Write-QualificationEvent $lease @{event='failed';runId=$runId;uncertain=$uncertain;at=[DateTime]::UtcNow.ToString('o')}
    } finally {
        if ($beganMutation) {
            try {
                $current = Get-VM -Id ([Guid]$Config.vmId)
                if ($current.Name -ne $Config.vmName -or $current.Notes -ne $script:VmOwnership) { throw 'VM ownership changed during the run.' }
                if ([string]$current.State -ne 'Off') {
                    $job = Stop-VM -VM $current -TurnOff -Confirm:$false -AsJob; $jobs.Add($job)
                    $null = Wait-QualificationJob $job 120
                }
                if ([string](Get-VM -Id ([Guid]$Config.vmId)).State -ne 'Off') { throw 'Guest process termination is unconfirmed.' }
                # Never restore while an earlier management action is uncertain.
                if (-not $uncertain) {
                    $job = Restore-VMSnapshot -VMSnapshot $machine.Snapshot -Confirm:$false -AsJob; $jobs.Add($job)
                    $null = Wait-QualificationJob $job 120
                    if ([string](Get-VM -Id ([Guid]$Config.vmId)).State -ne 'Off') { throw 'Baseline restore did not leave the guest off.' }
                    $cleanupConfirmed = $true
                }
            } catch { $uncertain = $true; if (-not $caught) { $caught = $_ } }
        }
        Write-QualificationEvent $lease @{event='terminal';runId=$runId;cleanupConfirmed=$cleanupConfirmed;quarantined=$uncertain;at=[DateTime]::UtcNow.ToString('o')}
        $lease.Dispose()
        foreach ($job in $jobs) { if ([string]$job.State -in @('Completed','Failed','Stopped')) { Remove-Job -Job $job -ErrorAction SilentlyContinue } }
        if ($cleanupConfirmed -and -not $uncertain) {
            [IO.File]::Move($leasePath, [IO.Path]::Combine($EvidenceRoot,'vm-' + $Config.vmId + '-' + $runId + '.completed.jsonl'))
        }
    }
    if ($caught) { throw $caught }
    if (-not $cleanupConfirmed -or $uncertain) { throw 'Qualification VM remains quarantined; no completed execution evidence is available.' }
    $result | Add-Member -NotePropertyName cleanupConfirmed -NotePropertyValue $true
    $result | Add-Member -NotePropertyName finishedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
    return $result
}

Export-ModuleMember -Function Get-QualificationHostStatus, Assert-QualificationPath, Assert-QualificationVmConfig, Assert-QualificationEgressControl, Invoke-QualificationVmRun
