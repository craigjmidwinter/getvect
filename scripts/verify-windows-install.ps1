# Verify a GetVect Windows installer end to end, on a real Windows machine —
# the check no CI runner performs: the smoke workflow proves the exe *builds*;
# this proves it *installs*, per-user, without elevation, and uninstalls clean.
#
# Run it over ssh against the fabric's Windows box (windesk). GUI launch is out
# of scope on purpose: an ssh session cannot render a window, and scheduled
# tasks run in the logged-on user's session, where a surprise window is not
# acceptable. What this script can honestly verify is the filesystem, the
# version resources, and the registry — which is exactly what the site's
# installer claims are about.
#
#   gh run download <run-id> -n getvect-windows-installer -D installer
#   ssh windesk "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force C:\Users\Public\gvtest | Out-Null\""
#   scp installer/GetVect-<version>-x64.exe scripts/verify-windows-install.ps1 windesk:'C:/Users/Public/gvtest/'
#   ssh windesk "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\gvtest\verify-windows-install.ps1 -Version <version>"
#   ssh windesk 'Remove-Item -Recurse -Force C:\Users\Public\gvtest'
#
# HARD-WON DETAILS, all observed on windesk 2026-08-19 (the first time anyone
# installed the exe):
#   - Everything lives under C:\Users\Public\gvtest because schtasks /tr
#     mangles quoted paths and "C:\Users\Craig Midwinter" has a space in it.
#   - ssh gives an admin user an ELEVATED token, so a plain install over ssh
#     proves nothing about the no-admin claim. `runas /trustlevel:0x20000`
#     needs an interactive desktop and silently does nothing over ssh. A
#     scheduled task with /RL LIMITED is what actually yields the filtered
#     Medium-IL token — and the token is probed and asserted, not assumed.
#   - The NSIS uninstaller re-spawns itself from %TEMP% so it can delete its
#     own directory; -Wait returns before the work is done. Poll.
#   - The installer caches a full copy of itself in
#     %LOCALAPPDATA%\getvect-updater\installer.exe and the uninstaller does
#     NOT remove it. The final phase checks for it so the residue is reported
#     rather than silently accumulating 100 MB per test.
#   - Windows pads the version resource: ProductVersion reports 0.1.0.0 for a
#     0.1.0 build. Assert on FileVersion.
param(
  # The version the installer claims to be, e.g. 0.1.0. FileVersion and the
  # HKCU DisplayVersion are asserted against it.
  [Parameter(Mandatory = $true)] [string]$Version,
  # Set to keep GetVect installed afterwards (e.g. to test updater discovery
  # against the next release). Default is to uninstall and verify clean.
  [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
$BASE = 'C:\Users\Public\gvtest'
$failed = $false
function Check($name, $ok, $detail) {
  if (-not $ok) { $script:failed = $true }
  Write-Output ("[{0}] {1}: {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail)
}
function RunLimited($taskName, $command, $timeoutSec) {
  schtasks /create /f /tn $taskName /tr $command /sc once /st 23:59 /rl LIMITED | Out-Null
  schtasks /run /tn $taskName | Out-Null
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    Start-Sleep -Seconds 2
    $status = (schtasks /query /tn $taskName /fo csv /nh) -split ',' | ForEach-Object { $_.Trim('"') }
  } while ($status[2] -eq 'Running' -and (Get-Date) -lt $deadline)
  schtasks /delete /f /tn $taskName | Out-Null
}

$exe = Get-ChildItem $BASE -Filter "GetVect-$Version-*.exe" | Select-Object -First 1
if (-not $exe) { throw "no GetVect-$Version-*.exe in $BASE" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\GetVect'
$appExe = Join-Path $installDir 'GetVect.exe'
$uninst = Join-Path $installDir 'Uninstall GetVect.exe'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\GetVect.lnk'
$updaterCache = Join-Path $env:LOCALAPPDATA 'getvect-updater'
function HkcuKey {
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { ($_ | Get-ItemProperty).DisplayName -like '*GetVect*' }
}
function HklmKeys {
  @(Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
      Where-Object { ($_ | Get-ItemProperty).DisplayName -like '*GetVect*' })
}

Check 'starts-clean' (-not (Test-Path $installDir) -and (HkcuKey).Count -eq 0) 'no install dir, no HKCU key'

# --- The token: prove LIMITED really strips elevation, then install under it -
$probe = Join-Path $BASE 'token-probe.txt'
Remove-Item $probe -ErrorAction SilentlyContinue
$probeCmd = Join-Path $BASE 'probe.cmd'
Set-Content -Path $probeCmd -Encoding ascii -Value ('whoami /groups /fo list > "' + $probe + '"')
RunLimited 'GetVectTokenProbe' ('"' + $probeCmd + '"') 30
$groups = if (Test-Path $probe) { Get-Content $probe -Raw -Encoding oem } else { '' }
$mediumIL = $groups -match 'Medium Mandatory Level'
$adminEnabled = $groups -match '(?s)BUILTIN\\Administrators.{0,200}?Enabled group'
Check 'token-is-unelevated' ($mediumIL -and -not $adminEnabled) ("medium-IL={0} admin-group-enabled={1}" -f $mediumIL, [bool]$adminEnabled)

$instCmd = Join-Path $BASE 'install.cmd'
Set-Content -Path $instCmd -Encoding ascii -Value ('"' + $exe.FullName + '" /S')
RunLimited 'GetVectLimitedInstall' ('"' + $instCmd + '"') 180
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path $appExe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
Check 'installed-binary' (Test-Path $appExe) $appExe
if (Test-Path $appExe) {
  $vi = (Get-Item $appExe).VersionInfo
  Check 'binary-version' ($vi.FileVersion -eq $Version) ("FileVersion={0} ProductName={1}" -f $vi.FileVersion, $vi.ProductName)
}
$updateYml = Join-Path $installDir 'resources\app-update.yml'
Check 'app-update-yml' (Test-Path $updateYml) $updateYml
Check 'uninstaller-exists' (Test-Path $uninst) $uninst
$hkcu = HkcuKey
Check 'hkcu-uninstall-key' ($hkcu.Count -eq 1) $(if ($hkcu) { $p = $hkcu[0] | Get-ItemProperty; "DisplayName='$($p.DisplayName)' DisplayVersion=$($p.DisplayVersion)" } else { 'not found' })
if ($hkcu.Count -eq 1) {
  Check 'hkcu-version' (($hkcu[0] | Get-ItemProperty).DisplayVersion -eq $Version) ("DisplayVersion={0}" -f ($hkcu[0] | Get-ItemProperty).DisplayVersion)
}
Check 'no-hklm-key' ((HklmKeys).Count -eq 0) 'nothing machine-wide'
Check 'no-program-files' (-not ((Test-Path 'C:\Program Files\GetVect') -or (Test-Path 'C:\Program Files (x86)\GetVect'))) 'nothing under Program Files'
Check 'start-menu-shortcut' (Test-Path $lnk) $lnk

if (-not $KeepInstalled) {
  # --- Uninstall, and verify it actually cleans up --------------------------
  Start-Process -FilePath $uninst -ArgumentList '/S' -Wait
  $deadline = (Get-Date).AddSeconds(90)
  while ((Test-Path $installDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  Check 'uninstall-removes-dir' (-not (Test-Path $installDir)) $installDir
  Check 'uninstall-removes-hkcu' ((HkcuKey).Count -eq 0) 'HKCU uninstall key'
  Check 'uninstall-removes-shortcut' (-not (Test-Path $lnk)) $lnk
  # Known residue (see header). Remove it so tests don't stack 100 MB copies;
  # report it so the fact stays visible.
  $residue = Test-Path $updaterCache
  Remove-Item -Recurse -Force $updaterCache -ErrorAction SilentlyContinue
  Check 'updater-cache-residue' $true $(if ($residue) { 'present as expected (uninstaller leaves it); removed' } else { 'absent' })
}

Write-Output ''
Write-Output $(if ($failed) { 'RESULT: FAIL' } else { 'RESULT: ALL CHECKS PASS' })
if ($failed) { exit 1 }
