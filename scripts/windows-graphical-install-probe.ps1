[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Installer,
    [Parameter(Mandatory)] [string]$WorkDirectory,
    [switch]$RequireMissingWebView2,
    [ValidateRange(1, 10)] [int]$TimeoutMultiplier = 1
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$setup = Get-Item -LiteralPath $Installer
$work = (Resolve-Path -LiteralPath $WorkDirectory).Path
if ($setup.PSIsContainer -or $setup.VersionInfo.ProductName -ne 'OHJingJing') {
    throw 'Select an OHJingJing setup executable.'
}
$version = ([version]$setup.VersionInfo.ProductVersion).ToString(3)
$app = Join-Path $work 'OHJingJing Installed'
$uninstall = Join-Path $app 'uninstall.exe'
$executable = Join-Path $app 'ohjingjing.exe'
$profile = Join-Path $work 'profile'
$entry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OHJingJing'
$lastDirectoryKey = 'HKCU:\Software\ohjingjing\OHJingJing'
$defaultInstall = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OHJingJing\ohjingjing.exe'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'OHJingJing.lnk'
$programs = [Environment]::GetFolderPath('Programs')
$startMenu = Join-Path $programs 'OHJingJing.lnk'
$appId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$env:TEMP = $work
$env:TMP = $work
$env:OHJINGJING_DATA_DIR = $profile

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class SetupProbeWindow {
    private delegate bool Visit(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit visit, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Visit visit, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr value, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr value, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr value, string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr value, IntPtr data, uint flags, uint timeout, out IntPtr result);

    public static IntPtr Find(uint pid, bool installer) {
        var match = IntPtr.Zero;
        var text = new StringBuilder(256);
        EnumWindows((window, _) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) return true;
            if (installer) {
                GetClassName(window, text, text.Capacity);
                if (text.ToString() != "#32770") return true;
            }
            GetWindowText(window, text, text.Capacity);
            if (!text.ToString().Contains("OHJingJing")) return true;
            match = window;
            return false;
        }, IntPtr.Zero);
        return match;
    }

    public static IntPtr Control(IntPtr window, string kind, string caption) {
        var result = IntPtr.Zero;
        var expression = new Regex(caption, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var text = new StringBuilder(512);
        EnumChildWindows(window, (control, _) => {
            if (!IsWindowEnabled(control)) return true;
            GetClassName(control, text, text.Capacity);
            if (text.ToString() != kind) return true;
            IntPtr read;
            text.Clear();
            SendMessageTimeout(control, 0x000D, new IntPtr(text.Capacity), text, 2, 500, out read);
            if (!expression.IsMatch(text.ToString().Replace("&", ""))) return true;
            result = control;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static string Buttons(IntPtr window) {
        var details = new StringBuilder();
        var text = new StringBuilder(256);
        EnumChildWindows(window, (control, _) => {
            GetClassName(control, text, text.Capacity);
            if (text.ToString() != "Button") return true;
            IntPtr read;
            text.Clear();
            SendMessageTimeout(control, 0x000D, new IntPtr(text.Capacity), text, 2, 500, out read);
            details.Append(GetDlgCtrlID(control)).Append('=').Append(text.ToString());
            details.Append(IsWindowEnabled(control) ? " (enabled), " : " (disabled), ");
            return true;
        }, IntPtr.Zero);
        return details.ToString();
    }

    public static bool Click(IntPtr button) {
        return PostMessage(GetParent(button), 0x0111, new IntPtr(GetDlgCtrlID(button)), button);
    }

    public static bool SetText(IntPtr field, string value) {
        IntPtr result;
        return SendMessageTimeout(field, 0x000C, IntPtr.Zero, value, 2, 1000, out result) != IntPtr.Zero && result != IntPtr.Zero;
    }

    public static bool SetChecked(IntPtr field, bool enabled) {
        IntPtr result;
        var value = new IntPtr(enabled ? 1 : 0);
        if (SendMessageTimeout(field, 0x00F1, value, IntPtr.Zero, 2, 1000, out result) == IntPtr.Zero) return false;
        return SendMessageTimeout(field, 0x00F0, IntPtr.Zero, IntPtr.Zero, 2, 1000, out result) != IntPtr.Zero && result == value;
    }
    public static bool Close(IntPtr window) { return PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

function Read-WebView2 {
    $versions = foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node','HKLM:\SOFTWARE','HKCU:\SOFTWARE') {
        (Get-ItemProperty -LiteralPath "$root\Microsoft\EdgeUpdate\Clients\$appId" -Name pv -ErrorAction SilentlyContinue).pv
    }
    return $versions | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '0.0.0.0' } | Select-Object -First 1
}

function Wait-Until([string]$Label, [scriptblock]$Read, [int]$Seconds = 12) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $timeout = $Seconds * $TimeoutMultiplier
    do {
        $result = & $Read
        if ($result) { return $result }
        Start-Sleep -Milliseconds 160
    } while ($deadline.Elapsed.TotalSeconds -lt $timeout)
    throw "Timed out at $Label."
}

function Find-Control([IntPtr]$Window, [string]$Kind, [string]$Name) {
    $control = [SetupProbeWindow]::Control($Window, $Kind, $Name)
    if ($control -ne [IntPtr]::Zero) { $control }
}

function Click-Control([IntPtr]$Button) {
    if (![SetupProbeWindow]::Click($Button)) { throw 'Could not click a control in the installer.' }
}

function Match-Target([string]$Link) {
    $shortcut = $shell.CreateShortcut($Link)
    return $shortcut.TargetPath -ieq $executable
}

if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'Run inside a signed-in Windows desktop session.' }
foreach ($occupied in $app, $profile, $entry, $lastDirectoryKey, $defaultInstall, $desktop, $startMenu) {
    if (Test-Path -LiteralPath $occupied) { throw 'Use a clean application profile and work directory.' }
}
if (Get-Process ohjingjing -ErrorAction SilentlyContinue) { throw 'Close the existing desktop application before running the probe.' }
$preinstalled = Read-WebView2
if ($RequireMissingWebView2 -and $preinstalled) { throw 'WebView2 is already present in this environment.' }
$shell = New-Object -ComObject WScript.Shell
$wizard = $null
$pet = $null
$manufacturerExisted = Test-Path -LiteralPath 'HKCU:\Software\ohjingjing'
try {
    $wizard = Start-Process -FilePath $setup.FullName -ArgumentList "/D=$app" -WorkingDirectory $work -WindowStyle Hidden -PassThru
    $handle = Wait-Until 'installer window' {
        $wizard.Refresh()
        if ($wizard.HasExited) { throw "Setup exited early with code $($wizard.ExitCode)." }
        $windowHandle = [SetupProbeWindow]::Find([uint32]$wizard.Id, $true)
        if ($windowHandle -ne [IntPtr]::Zero) { $windowHandle }
    }
    $next = Wait-Until 'welcome page' { Find-Control $handle 'Button' '^Next' }
    Click-Control $next
    $directory = Wait-Until 'installation directory field' { Find-Control $handle 'Edit' '.*' }
    if (![SetupProbeWindow]::SetText($directory, $app)) { throw 'Could not select the isolated install path.' }
    $install = Wait-Until 'continue from the install directory' { Find-Control $handle 'Button' '^(?:Install|Next)' }
    Click-Control $install
    $finish = Wait-Until 'finish page or installation details' {
        $check = Find-Control $handle 'Button' '^Finish$'
        if ($check) { return $check }
        $advance = Find-Control $handle 'Button' '^Next'
        if ($advance) { Click-Control $advance }
    } $(if ($preinstalled) { 55 } else { 240 })
    $shortcutChoice = Wait-Until 'desktop shortcut option' { Find-Control $handle 'Button' 'Create.*Desktop Shortcut' }
    $launchChoice = Wait-Until 'launch option' { Find-Control $handle 'Button' '^Run' }
    if (![SetupProbeWindow]::SetChecked($shortcutChoice, $true) -or ![SetupProbeWindow]::SetChecked($launchChoice, $false)) {
        throw 'Could not select the desktop shortcut option.'
    }
    Click-Control $finish
    if (!$wizard.WaitForExit(8000 * $TimeoutMultiplier) -or $wizard.ExitCode -ne 0) { throw 'Graphical setup did not complete successfully.' }
    $installedRuntime = Wait-Until 'WebView2 registration' { Read-WebView2 } 20
    $installed = Get-ItemProperty -LiteralPath $entry
    if ($installed.DisplayVersion -ne $version -or $installed.InstallLocation.Trim('"') -ine $app) {
        throw 'Graphical setup registered an unexpected application or version.'
    }
    foreach ($link in $desktop, $startMenu) {
        if (!(Test-Path -LiteralPath $link -PathType Leaf) -or !(Match-Target $link)) { throw 'Missing or incorrect application shortcut.' }
    }
    $pet = Start-Process -FilePath $desktop -WorkingDirectory $work -WindowStyle Hidden -PassThru
    if ($pet.MainModule.FileName -ine $executable) { throw 'Shortcut launched an unexpected process.' }
    $petWindow = Wait-Until 'desktop shortcut launch' {
        $pet.Refresh()
        if ($pet.HasExited) { throw "Desktop shortcut target exited with code $($pet.ExitCode)." }
        if (Test-Path -LiteralPath (Join-Path $profile 'EBWebView')) {
            $windowHandle = [SetupProbeWindow]::Find([uint32]$pet.Id, $false)
            if ($windowHandle -ne [IntPtr]::Zero) { $windowHandle }
        }
    } 22
    if (![SetupProbeWindow]::Close($petWindow) -or !$pet.WaitForExit(2500 * $TimeoutMultiplier)) {
        $pet.Kill()
        if (!$pet.WaitForExit(5000 * $TimeoutMultiplier)) { throw 'Could not stop the isolated shortcut process.' }
    } elseif ($pet.ExitCode -ne 0) {
        throw "Desktop exited with code $($pet.ExitCode)."
    }
    [pscustomobject]@{
        Version = $version
        WebView2Before = if ($preinstalled) { $preinstalled } else { $null }
        WebView2After = $installedRuntime
        DesktopShortcut = $true
        StartMenuShortcut = $true
        ShortcutLaunch = $true
    } | ConvertTo-Json -Compress
} catch {
    if ($handle -and $wizard -and !$wizard.HasExited) {
        "Installer controls at failure: $([SetupProbeWindow]::Buttons($handle))"
    }
    throw
} finally {
    foreach ($child in $pet, $wizard) {
        if ($child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
    }
    if (Test-Path -LiteralPath $entry) {
        $installed = Get-ItemProperty -LiteralPath $entry
        if ($installed.InstallLocation.Trim('"') -ine $app -or $installed.UninstallString.Trim('"') -ine $uninstall) {
            throw 'Refusing to remove a Windows app registration outside the work directory.'
        }
        $cleanup = Start-Process -FilePath $uninstall -ArgumentList '/S' -WorkingDirectory $work -WindowStyle Hidden -Wait -PassThru
        if ($cleanup.ExitCode -ne 0) { throw "Uninstall exited with code $($cleanup.ExitCode)." }
    }
    foreach ($artifact in $entry, $desktop, $startMenu, $executable, $uninstall) {
        if (Test-Path -LiteralPath $artifact) { throw 'Uninstall left an application file, link or Apps entry.' }
    }
    if ((Test-Path -LiteralPath $lastDirectoryKey) -and
        (Get-Item -LiteralPath $lastDirectoryKey).GetValue('') -ieq $app) {
        Remove-Item -LiteralPath $lastDirectoryKey
    }
    $publisher = Get-Item -LiteralPath 'HKCU:\Software\ohjingjing' -ErrorAction SilentlyContinue
    if (!$manufacturerExisted -and $publisher -and $publisher.SubKeyCount -eq 0 -and $publisher.ValueCount -eq 0) {
        Remove-Item -LiteralPath 'HKCU:\Software\ohjingjing'
    }
}
'Uninstall removed both shortcuts, installation files and the Windows Apps entry.'
