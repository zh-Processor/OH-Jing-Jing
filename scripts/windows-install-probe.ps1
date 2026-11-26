[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('preflight', 'install', 'verify', 'diagnose', 'verify-webview2', 'uninstall', 'cleanup')] [string]$Action,
    [Parameter(Mandatory)] [string]$InstallDirectory,
    [string]$Installer,
    [string]$PreviousInstaller,
    [string]$WebViewProfile,
    [switch]$RequireCleanWebView2,
    [switch]$RemoveEmptyManufacturer
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$temporary = (Get-Item -LiteralPath $env:TEMP).FullName
$app = [IO.Path]::GetFullPath($InstallDirectory)
if ([IO.Path]::GetDirectoryName($app) -ine $temporary) { throw 'Use an app directory directly inside this test session TEMP.' }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OHJingJing'
$rememberedKey = 'HKCU:\Software\ohjingjing\OHJingJing'
$uninstall = Join-Path $app 'uninstall.exe'
$hostInstall = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OHJingJing'
$shortcuts = @(foreach ($folder in 'DesktopDirectory','Programs','CommonDesktopDirectory','CommonPrograms') {
    $path = [Environment]::GetFolderPath($folder)
    if ($path) { Join-Path $path 'OHJingJing.lnk' }
})

function Confirm-HostLocations {
    if (Test-Path -LiteralPath $hostInstall) { throw 'The default install directory is in use.' }
    foreach ($shortcut in $shortcuts) {
        if (Test-Path -LiteralPath $shortcut) { throw 'An OHJingJing shortcut already exists in the host profile.' }
    }
}

function Read-SetupVersion([string]$Path) {
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer -or $file.VersionInfo.ProductName -ne 'OHJingJing') { throw 'Select an OHJingJing setup executable.' }
    return ([version]$file.VersionInfo.ProductVersion).ToString(3)
}

function Get-WebView2Runtime {
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $registered = @(foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node','HKLM:\SOFTWARE','HKCU:\SOFTWARE') {
        $version = (Get-ItemProperty -LiteralPath "$root\Microsoft\EdgeUpdate\Clients\$id" -Name pv -ErrorAction SilentlyContinue).pv
        if ($version -match '^\d+\.\d+\.\d+\.\d+$' -and $version -ne '0.0.0.0') { $version }
    })
    $executables = @(foreach ($base in 'ProgramFilesX86','ProgramFiles','LocalApplicationData') {
        $path = [Environment]::GetFolderPath($base)
        if (!$path) { continue }
        $application = Join-Path $path 'Microsoft\EdgeWebView\Application'
        foreach ($folder in Get-ChildItem -LiteralPath $application -Directory -ErrorAction SilentlyContinue) {
            $exe = Get-Item -LiteralPath (Join-Path $folder.FullName 'msedgewebview2.exe') -ErrorAction SilentlyContinue
            if ($exe -and !$exe.PSIsContainer) { $exe }
        }
    })
    [pscustomobject]@{ Registered=$registered; Executables=$executables }
}

function Confirm-CleanWebView2($Runtime) {
    if ($Runtime.Registered.Count -or $Runtime.Executables.Count) {
        throw 'The clean WebView2 check found an existing runtime registration or executable before setup.'
    }
    if ($env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER) {
        throw 'The clean WebView2 check must use the default browser executable lookup.'
    }
}

function Get-TestWebViewProcesses {
    if (!$WebViewProfile) { return }
    $profile = [IO.Path]::GetFullPath($WebViewProfile)
    if ([IO.Path]::GetDirectoryName($profile) -ine $temporary) { throw 'Use the WebView profile in this test session.' }
    $pattern = '(?:^|\s)"?--user-data-dir="?' + [regex]::Escape($profile) + '(?:\\|/|"|\s|$)'
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match $pattern }
}

function Confirm-OwnedRegistryEntry {
    if (-not (Test-Path -LiteralPath $uninstallKey)) { return $false }
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.InstallLocation.Trim('"') -ine $app -or $registration.UninstallString.Trim('"') -ine $uninstall) {
        throw 'An install registration outside the test directory is in use.'
    }
    return $true
}

function Test-RegisteredVersion([string]$Version) {
    if (-not (Confirm-OwnedRegistryEntry)) { return $false }
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.DisplayVersion -ne $Version -or $registration.DisplayName -ne 'OHJingJing') { return $false }
    foreach ($file in 'ohjingjing.exe','node.exe','runtime.mjs','uninstall.exe') {
        if (-not (Test-Path -LiteralPath (Join-Path $app $file) -PathType Leaf)) { return $false }
    }
    Confirm-HostLocations
    return $true
}

function Invoke-TestExecutable([string]$File, [string]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $temporary -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Setup returned Windows exit code $($process.ExitCode)." }
}

function Remove-TestInstall {
    if (-not (Confirm-OwnedRegistryEntry)) { return }
    $entry = Get-Item -LiteralPath $uninstall
    if ($entry.DirectoryName -ine $app -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The test uninstaller is outside the expected directory.'
    }
    Invoke-TestExecutable $uninstall '/S'
    if (Test-Path -LiteralPath $uninstallKey) { throw 'Uninstall did not remove the Windows Apps registration.' }
    foreach ($name in 'ohjingjing.exe','node.exe','runtime.mjs','uninstall.exe') {
        if (Test-Path -LiteralPath (Join-Path $app $name)) { throw "Uninstall left $name installed." }
    }
    Confirm-HostLocations
}

switch ($Action) {
    'preflight' {
        Confirm-HostLocations
        if ((Test-Path -LiteralPath $rememberedKey) -or (Test-Path -LiteralPath $app) -or (Get-Process ohjingjing -ErrorAction SilentlyContinue)) {
            throw 'Use a Windows profile with no existing OHJingJing installation or running copy.'
        }
        foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
            $installed = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Where-Object {
                $_.PSChildName -ieq 'OHJingJing' -or $_.GetValue('DisplayName') -ieq 'OHJingJing'
            }
            if ($installed) { throw 'A Windows uninstall registration for OHJingJing already exists.' }
        }
        $runtime = Get-WebView2Runtime
        if ($RequireCleanWebView2) { Confirm-CleanWebView2 $runtime }
        $version = $runtime.Registered | Select-Object -First 1
        if (!$RequireCleanWebView2 -and !$version) { throw 'Run this lifecycle check on Windows with an existing WebView2 Runtime.' }
        $current = Read-SetupVersion $Installer
        $previous = if ($PreviousInstaller) { Read-SetupVersion $PreviousInstaller }
        if ($previous -and [version]$previous -ge [version]$current) { throw 'Supply a lower setup version followed by a newer release.' }
        [pscustomobject]@{Previous=$previous; Current=$current; WebView2=$version; ManufacturerExisted=(Test-Path -LiteralPath 'HKCU:\Software\ohjingjing')} |
            ConvertTo-Json -Compress
    }
    'install' {
        $version = Read-SetupVersion $Installer
        $null = Confirm-OwnedRegistryEntry
        if ($RequireCleanWebView2) { Confirm-CleanWebView2 (Get-WebView2Runtime) }
        Invoke-TestExecutable $Installer "/S /NS /D=$app"
        if (!(Test-RegisteredVersion $version)) { throw 'The installed files or Windows Apps registration did not match the expected setup.' }
    }
    'verify' { if (Test-RegisteredVersion (Read-SetupVersion $Installer)) { Write-Output 'ready' } }
    'verify-webview2' {
        $runtime = Get-WebView2Runtime
        $browsers = @(Get-TestWebViewProcesses | ForEach-Object ExecutablePath)
        foreach ($exe in $runtime.Executables) {
            $version = $exe.VersionInfo.ProductVersion
            if ($version -in $runtime.Registered -and $exe.FullName -in $browsers) {
                Write-Output $version
                break
            }
        }
    }
    'diagnose' {
        $registered = if (Confirm-OwnedRegistryEntry) { (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion }
        $workers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.ExecutablePath -ieq (Join-Path $app 'node.exe')
        })
        $browserCount = @(Get-TestWebViewProcesses).Count
        $installerCount = 0
        if ($Installer) {
            $version = Read-SetupVersion $Installer
            $name = "OHJingJing-$version-installer.exe"
            $prefix = Join-Path $temporary "OHJingJing-$version-updater-"
            $installerCount = @(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
            }).Count
        }
        [pscustomobject]@{Registered=$registered; WorkerCount=$workers.Count; BrowserCount=$browserCount; InstallerCount=$installerCount;
            AppPresent=(Test-Path -LiteralPath (Join-Path $app 'ohjingjing.exe') -PathType Leaf)} | ConvertTo-Json -Compress
    }
    'uninstall' {
        if (-not (Confirm-OwnedRegistryEntry)) { throw 'Expected a Windows Apps registration before uninstall.' }
        Remove-TestInstall
    }
    'cleanup' {
        Remove-TestInstall
        $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\ohjingjing', $true)
        if ($root) {
            try {
                $entry = $root.OpenSubKey('OHJingJing')
                if ($entry) {
                    try { $location = $entry.GetValue('') }
                    finally { $entry.Dispose() }
                    if ($location -ieq $app) { $root.DeleteSubKey('OHJingJing', $false) }
                }
                if ($RemoveEmptyManufacturer -and $root.SubKeyCount -eq 0 -and $root.ValueCount -eq 0) {
                    $software = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software', $true)
                    try { $software.DeleteSubKey('ohjingjing', $false) }
                    finally { $software.Dispose() }
                }
            } finally {
                $root.Dispose()
            }
        }
    }
}
