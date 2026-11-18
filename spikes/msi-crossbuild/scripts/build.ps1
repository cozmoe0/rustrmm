#Requires -Version 5.1
<#
  Windows-side wrapper for the spike: build the agent exe with the host's MSVC toolchain, then
  compile the MSIs with wixl inside WSL. (The real pipeline would do both inside one Linux
  Docker image; see FINDINGS.md.)

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1 [-Distro kali-linux] [-Version 0.1.0]
#>
param(
    [string]$Distro = 'kali-linux',
    [string]$Version = '0.1.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Windows PowerShell 5.1 turns native stderr (cargo progress) into errors under 'Stop' when
# redirected, so run native tools with 'Continue' and rely on the exit code.
function Invoke-Native([string]$what, [scriptblock]$command) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $command 2>&1 | ForEach-Object { "$_" } }
    finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Invoke-Native 'cargo build' { cargo build --release --manifest-path (Join-Path $root 'agent\Cargo.toml') }

$wslRoot = (wsl.exe -d $Distro -e wslpath -a ($root -replace '\\', '/')).Trim()
Invoke-Native 'build-msi.sh' {
    wsl.exe -d $Distro -e bash "$wslRoot/scripts/build-msi.sh" "$wslRoot/agent/target/release/rustrmm-spike-agent.exe" $Version
}

& (Join-Path $PSScriptRoot 'inspect-msi.ps1') -Msi (Join-Path $root 'out\RustRMMSpikeAgent.msi') | Select-Object -First 2
