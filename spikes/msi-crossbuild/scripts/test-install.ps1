#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Elevated install/uninstall tests for the RustRMM MSI spike.

.DESCRIPTION
  Run from an elevated Windows PowerShell after building out\RustRMMSpikeAgent*.msi:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-install.ps1

  Each test installs silently (/qn), checks, uninstalls, and checks the removal:
    A  DEPLOY_KEY property + sidecar deploy.key  -> property wins; agent deletes the registry value
    B  sidecar deploy.key only (the GPO case)    -> found via MsiGetProductInfoW(InstallSource)
       B2: a different build with the same ProductCode is refused while installed (1638)
    E  no key at all                             -> install still succeeds, agent keeps retrying,
                                                    uninstall stops it promptly
    C  hardened MSI + DEPLOY_KEY                 -> HKLM\SOFTWARE\RustRMMSpike DACL is SYSTEM +
                                                    Administrators only (MsiLockPermissionsEx)

  Results: out\test-results\results.txt, plus msiexec verbose logs and agent logs per test.
  Only touches this spike's state: the RustRMMSpikeAgent service, "C:\Program Files\RustRMM Spike",
  the DeployKey/SourcePackage values under HKLM\SOFTWARE\RustRMMSpike, and the files msi.log and
  msi-agent.conf in C:\ProgramData\RustRMMSpike. That folder is shared with other spikes
  (frames\, logs\, conpty-service.log), so it is never deleted. The deploy keys are random dummies.
#>
param([switch]$SkipHardened)
$ErrorActionPreference = 'Stop'

$root        = Split-Path -Parent $PSScriptRoot
$out         = Join-Path $root 'out'
$results     = Join-Path $out 'test-results'
$report      = Join-Path $results 'results.txt'
$productCode = '{7C26286F-1047-4CA2-B343-2797FAD7228C}'
$service     = 'RustRMMSpikeAgent'
$dataDir     = Join-Path $env:ProgramData 'RustRMMSpike'
$regPath     = 'HKLM:\SOFTWARE\RustRMMSpike'
$regPath32   = 'HKLM:\SOFTWARE\WOW6432Node\RustRMMSpike'
$installDir  = Join-Path $env:ProgramFiles 'RustRMM Spike'
$arpPath     = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$productCode"
$msiMain     = Join-Path $out 'RustRMMSpikeAgent.msi'
$msiHardened = Join-Path $out 'RustRMMSpikeAgent-hardened.msi'

foreach ($f in $msiMain, $msiHardened) {
    if (-not (Test-Path $f)) { throw "missing $f - build it first (scripts\build.ps1)" }
}
if (Test-Path $results) { Remove-Item $results -Recurse -Force }
New-Item -ItemType Directory -Path $results | Out-Null
$script:failures = 0

function Write-Report([string]$text) {
    Write-Host $text
    Add-Content -Path $report -Value $text -Encoding UTF8
}

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { $tag = 'PASS' } else { $tag = 'FAIL'; $script:failures++ }
    $line = "  [$tag] $name"
    if ($detail) { $line += " -- $detail" }
    Write-Report $line
}

$installer = New-Object -ComObject WindowsInstaller.Installer
function Get-ProductState {
    # 5 = installed, -1 = unknown product
    $installer.GetType().InvokeMember('ProductState', 'GetProperty', $null, $installer, @($productCode))
}
function Get-ProductInfo([string]$attribute) {
    try { $installer.GetType().InvokeMember('ProductInfo', 'GetProperty', $null, $installer, @($productCode, $attribute)) }
    catch { "<$($_.Exception.InnerException.Message)>" }
}

function Invoke-Msi([string]$arguments, [string]$logName) {
    $log = Join-Path $results $logName
    $p = Start-Process -FilePath msiexec.exe -ArgumentList "$arguments /qn /norestart /l*v `"$log`"" -Wait -PassThru
    return $p.ExitCode
}

# C:\ProgramData\RustRMMSpike is shared with other spikes: only ever remove this spike's own files.
$agentFiles = 'msi.log', 'msi-agent.conf'
function Reset-AgentData {
    foreach ($name in $agentFiles) {
        $path = Join-Path $dataDir $name
        if (Test-Path $path) { Remove-Item $path -Force }
    }
}

function Wait-AgentLog([string]$pattern, [int]$seconds) {
    $log = Join-Path $dataDir 'msi.log'
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern $pattern -Quiet)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Save-AgentFiles([string]$prefix) {
    foreach ($name in $agentFiles) {
        $src = Join-Path $dataDir $name
        if (Test-Path $src) { Copy-Item $src (Join-Path $results "$prefix-$name") }
    }
}

function Get-AgentConf {
    $path = Join-Path $dataDir 'msi-agent.conf'
    if (Test-Path $path) { return (Get-Content $path -Raw) }
    return ''
}

# Copy the MSI into its own folder (the "install source"), optionally with a sidecar deploy.key.
function New-Stage([string]$name, [string]$msi, [string]$sidecarKey) {
    $dir = Join-Path $results "stage-$name"
    New-Item -ItemType Directory -Path $dir | Out-Null
    $target = Join-Path $dir 'RustRMMSpikeAgent.msi'
    Copy-Item $msi $target
    if ($sidecarKey) {
        Set-Content -Path (Join-Path $dir 'deploy.key') -Value $sidecarKey -Encoding ASCII -NoNewline
    }
    return $target
}

function Test-Installed([string]$prefix) {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$service'"
    Check "$prefix service installed" ($null -ne $svc)
    if ($svc) {
        Check "$prefix service running" ($svc.State -eq 'Running') $svc.State
        Check "$prefix service start mode Auto" ($svc.StartMode -eq 'Auto') $svc.StartMode
        Check "$prefix service account LocalSystem" ($svc.StartName -eq 'LocalSystem') $svc.StartName
        Check "$prefix service binary under 64-bit Program Files" ($svc.PathName -like "*$installDir*") $svc.PathName
        # An unquoted path with spaces is the classic "unquoted service path" finding.
        Check "$prefix service ImagePath is quoted" ($svc.PathName.StartsWith('"'))
    }
    Check "$prefix exe installed" (Test-Path (Join-Path $installDir 'rustrmm-spike-agent.exe'))
    $arp = Get-ItemProperty -Path $arpPath -ErrorAction SilentlyContinue
    Check "$prefix Add/Remove Programs entry present" ($null -ne $arp) $arpPath
    if ($arp) {
        Check "$prefix ARP NoRepair=1" ($arp.NoRepair -eq 1)
        Check "$prefix ARP NoModify=1" ($arp.NoModify -eq 1)
        Write-Report ("    ARP: DisplayName='{0}' DisplayVersion='{1}' Publisher='{2}' InstallSource='{3}' UninstallString='{4}'" -f `
            $arp.DisplayName, $arp.DisplayVersion, $arp.Publisher, $arp.InstallSource, $arp.UninstallString)
    }
    Write-Report ("    MsiGetProductInfo: InstallSource='{0}' PackageName='{1}' VersionString='{2}'" -f `
        (Get-ProductInfo 'InstallSource'), (Get-ProductInfo 'PackageName'), (Get-ProductInfo 'VersionString'))
}

function Test-Removed([string]$prefix) {
    Check "$prefix product unregistered" ((Get-ProductState) -eq -1) "ProductState=$(Get-ProductState)"
    Check "$prefix service removed" ($null -eq (Get-Service $service -ErrorAction SilentlyContinue))
    Check "$prefix install dir removed" (-not (Test-Path $installDir))
    Check "$prefix ARP entry removed" (-not (Test-Path $arpPath))
    Check "$prefix HKLM\SOFTWARE\RustRMMSpike removed" (-not (Test-Path $regPath))
    Write-Report "    (not MSI-managed) $dataDir\msi.log still exists: $(Test-Path (Join-Path $dataDir 'msi.log'))"
}

function Uninstall-Product([string]$prefix) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $code = Invoke-Msi "/x $productCode" "$prefix-uninstall.log"
    $sw.Stop()
    Check "$prefix uninstall exit code 0" ($code -eq 0) "exit $code after $([int]$sw.Elapsed.TotalSeconds)s"
    return $sw.Elapsed
}

function Test-LogHidesKey([string]$prefix, [string]$logName, [string]$key) {
    $log = Join-Path $results $logName
    $hits = @(Select-String -Path $log -SimpleMatch $key)
    Check "$prefix verbose MSI log does not contain the deploy key" ($hits.Count -eq 0) "$($hits.Count) occurrence(s)"
    foreach ($h in $hits) { Write-Report ("    leak: line {0}: {1}" -f $h.LineNumber, $h.Line.Trim()) }
    foreach ($h in @(Select-String -Path $log -SimpleMatch 'DEPLOY_KEY' | Select-Object -First 6)) {
        Write-Report ("    log: {0}" -f $h.Line.Trim())
    }
}

# ---------------------------------------------------------------------------------------------
Write-Report "RustRMM MSI spike install tests - $(Get-Date -Format s) - $([Environment]::OSVersion.VersionString)"
if ((Get-ProductState) -ne -1) {
    Write-Report "Product already installed (state $(Get-ProductState)); uninstalling first"
    [void](Invoke-Msi "/x $productCode" 'preflight-uninstall.log')
}
Reset-AgentData

$propKey = 'PROP' + [guid]::NewGuid().ToString('N')
$fileKey = 'FILE' + [guid]::NewGuid().ToString('N')

# ---------------------------------------------------------------------------------------------
Write-Report ''
Write-Report 'Test A: DEPLOY_KEY property + sidecar deploy.key (property must win)'
Reset-AgentData
$stage = New-Stage 'a' $msiMain $fileKey
$code = Invoke-Msi "/i `"$stage`" DEPLOY_KEY=$propKey" 'a-install.log'
Check 'A install exit code 0' ($code -eq 0) "exit $code"
Check 'A agent resolved a deploy key' (Wait-AgentLog 'deploy key resolved' 60)
Save-AgentFiles 'a'
$conf = Get-AgentConf
Check 'A key came from the registry (DEPLOY_KEY property)' ($conf -match 'key_source=registry') ($conf.Trim() -replace "`r?`n", '; ')
Check 'A key length matches the property' ($conf -match "key_len=$($propKey.Length)\b")
Check 'A agent deleted the DeployKey value after use' ($null -eq (Get-ItemProperty $regPath -Name DeployKey -ErrorAction SilentlyContinue))
$sourcePackage = (Get-ItemProperty $regPath -Name SourcePackage -ErrorAction SilentlyContinue).SourcePackage
Check 'A SourcePackage ([OriginalDatabase]) = staged MSI path' ($sourcePackage -eq $stage) "$sourcePackage"
Check 'A nothing written to WOW6432Node' (-not (Test-Path $regPath32))
Test-Installed 'A'
Write-Report "    default DACL of HKLM\SOFTWARE\RustRMMSpike: $((Get-Acl $regPath).Sddl)"
Test-LogHidesKey 'A' 'a-install.log' $propKey
[void](Uninstall-Product 'A')
Test-Removed 'A'

# ---------------------------------------------------------------------------------------------
Write-Report ''
Write-Report 'Test B: sidecar deploy.key only (the GPO path: no property)'
Reset-AgentData
$stage = New-Stage 'b' $msiMain $fileKey
$code = Invoke-Msi "/i `"$stage`"" 'b-install.log'
Check 'B install exit code 0' ($code -eq 0) "exit $code"
Check 'B agent resolved a deploy key' (Wait-AgentLog 'deploy key resolved' 90)
Save-AgentFiles 'b'
$conf = Get-AgentConf
$expectedFile = Join-Path (Split-Path $stage) 'deploy.key'
Check 'B key came from deploy.key next to the MSI' ($conf -match [regex]::Escape("key_source=file $expectedFile")) ($conf.Trim() -replace "`r?`n", '; ')
Check 'B key length matches deploy.key' ($conf -match "key_len=$($fileKey.Length)\b")
$agentLog = ''
if (Test-Path (Join-Path $results 'b-msi.log')) { $agentLog = Get-Content (Join-Path $results 'b-msi.log') -Raw }
$early = ([regex]::Matches($agentLog, 'InstallSource\) failed: 1605')).Count
Write-Report "    agent got ERROR_UNKNOWN_PRODUCT $early time(s) before the product was registered"
Check 'B no DeployKey value without the property' ($agentLog -match 'registry DeployKey \(64-bit view\): 2 ')
Test-Installed 'B'

Write-Report '  B2: install a different build of the same ProductCode while installed'
$code = Invoke-Msi "/i `"$msiHardened`"" 'b2-install-other-build.log'
Check 'B2 refused with 1638 (another version of this product is installed)' ($code -eq 1638) "exit $code"
Check 'B2 original install untouched' ((Get-ProductState) -eq 5) "ProductState=$(Get-ProductState)"
[void](Uninstall-Product 'B')
Test-Removed 'B'

# ---------------------------------------------------------------------------------------------
Write-Report ''
Write-Report 'Test E: no property and no sidecar (install must still succeed)'
Reset-AgentData
$stage = New-Stage 'e' $msiMain $null
$code = Invoke-Msi "/i `"$stage`"" 'e-install.log'
Check 'E install exit code 0' ($code -eq 0) "exit $code"
Check 'E agent is retrying' (Wait-AgentLog 'attempt 3:' 30)
Check 'E service running while retrying' ((Get-Service $service -ErrorAction SilentlyContinue).Status -eq 'Running')
$elapsed = Uninstall-Product 'E'
Check 'E uninstall stopped the retrying agent promptly' ($elapsed.TotalSeconds -lt 60) "$([int]$elapsed.TotalSeconds)s"
Save-AgentFiles 'e'
$stopLogged = (Test-Path (Join-Path $results 'e-msi.log')) -and (Select-String -Path (Join-Path $results 'e-msi.log') -SimpleMatch 'stop requested' -Quiet)
Check 'E agent logged the stop request' $stopLogged
Test-Removed 'E'

# ---------------------------------------------------------------------------------------------
if (-not $SkipHardened) {
    Write-Report ''
    Write-Report 'Test C: hardened MSI (MsiLockPermissionsEx added by msibuild) + DEPLOY_KEY'
    Reset-AgentData
    $stage = New-Stage 'c' $msiHardened $null
    $code = Invoke-Msi "/i `"$stage`" DEPLOY_KEY=$propKey" 'c-install.log'
    Check 'C install exit code 0' ($code -eq 0) "exit $code"
    Check 'C agent (LocalSystem) resolved a deploy key' (Wait-AgentLog 'deploy key resolved' 60)
    Save-AgentFiles 'c'
    $conf = Get-AgentConf
    Check 'C key came from the registry (DEPLOY_KEY property)' ($conf -match 'key_source=registry')
    if (Test-Path $regPath) {
        $acl = Get-Acl $regPath
        $sids = @($acl.Access | ForEach-Object {
            $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        } | Sort-Object -Unique)
        Write-Report "    DACL: $($acl.Sddl)"
        Check 'C DACL is protected (no inherited ACEs)' $acl.AreAccessRulesProtected
        Check 'C only SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544)' (($sids -join ',') -eq 'S-1-5-18,S-1-5-32-544') ($sids -join ', ')
    } else {
        Check 'C HKLM\SOFTWARE\RustRMMSpike exists for the ACL check' $false
    }
    Test-LogHidesKey 'C' 'c-install.log' $propKey
    [void](Uninstall-Product 'C')
    Test-Removed 'C'
}

# ---------------------------------------------------------------------------------------------
if ((Get-ProductState) -ne -1) { [void](Invoke-Msi "/x $productCode" 'final-uninstall.log') }
Reset-AgentData
if (Test-Path $regPath) {
    # Leftovers only; remove this spike's values, and the key only if nothing else lives in it.
    Remove-ItemProperty -Path $regPath -Name DeployKey, SourcePackage -ErrorAction SilentlyContinue
    $key = Get-Item $regPath
    if ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item $regPath }
}
Write-Report ''
if ($script:failures -eq 0) { Write-Report 'RESULT: all checks passed' }
else { Write-Report "RESULT: $($script:failures) check(s) FAILED" }
Write-Report "Details: $results"
exit $script:failures
