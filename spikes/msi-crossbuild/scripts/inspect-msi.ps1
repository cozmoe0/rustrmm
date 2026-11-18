#Requires -Version 5.1
<#
  Read a wixl-built MSI with the real Windows Installer engine (COM, read-only, no elevation)
  and print the tables that matter for the spike. Cross-checks msiinfo (libmsi, a Wine
  derivative) against msi.dll.

    powershell -File scripts\inspect-msi.ps1 [-Msi out\RustRMMSpikeAgent.msi]
#>
param([string]$Msi = (Join-Path $PSScriptRoot '..\out\RustRMMSpikeAgent.msi'))
$ErrorActionPreference = 'Stop'

function Invoke-Com($obj, [string]$member, [Reflection.BindingFlags]$kind, [object[]]$argv = $null) {
    $obj.GetType().InvokeMember($member, $kind, $null, $obj, $argv)
}
$method = [Reflection.BindingFlags]::InvokeMethod
$getter = [Reflection.BindingFlags]::GetProperty

$path = (Resolve-Path $Msi).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = Invoke-Com $installer 'OpenDatabase' $method @($path, 0)   # 0 = msiOpenDatabaseModeReadOnly

function Show-Query([string]$title, [string]$sql) {
    Write-Output "[$title]"
    try {
        $view = Invoke-Com $db 'OpenView' $method @($sql)
        [void](Invoke-Com $view 'Execute' $method)
        while ($null -ne ($rec = Invoke-Com $view 'Fetch' $method)) {
            $n = Invoke-Com $rec 'FieldCount' $getter
            # [int] cast: a PSObject-wrapped index makes the COM call fail with DISP_E_TYPEMISMATCH.
            $fields = 1..$n | ForEach-Object { Invoke-Com $rec 'StringData' $getter @([int]$_) }
            Write-Output ('  ' + ($fields -join ' | '))
        }
        [void](Invoke-Com $view 'Close' $method)
    } catch {
        Write-Output "  <query failed: $($_.Exception.InnerException.Message)>"
    }
}

$si = Invoke-Com $installer 'SummaryInformation' $getter @($path, 0)
Write-Output "MSI: $path"
Write-Output ("Template={0}  PackageCode={1}  PageCount={2}  WordCount={3}" -f `
    (Invoke-Com $si 'Property' $getter @(7)), (Invoke-Com $si 'Property' $getter @(9)),
    (Invoke-Com $si 'Property' $getter @(14)), (Invoke-Com $si 'Property' $getter @(15)))

Show-Query 'Property'        'SELECT `Property`, `Value` FROM `Property`'
Show-Query 'Component'       'SELECT `Component`, `Attributes`, `Condition`, `KeyPath` FROM `Component`'
Show-Query 'ServiceInstall'  'SELECT `Name`, `ServiceType`, `StartType`, `ErrorControl`, `StartName` FROM `ServiceInstall`'
Show-Query 'ServiceControl'  'SELECT `Name`, `Event`, `Wait` FROM `ServiceControl`'
Show-Query 'Registry'        'SELECT `Registry`, `Root`, `Key`, `Name`, `Value` FROM `Registry`'
Show-Query 'Upgrade'         'SELECT `VersionMin`, `VersionMax`, `Attributes`, `ActionProperty` FROM `Upgrade`'
Show-Query 'MsiLockPermissionsEx' 'SELECT `MsiLockPermissionsEx`, `LockObject`, `Table`, `SDDLText` FROM `MsiLockPermissionsEx`'
