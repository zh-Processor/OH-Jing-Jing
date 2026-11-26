[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
    [Parameter(Mandatory)] [string]$Config,
    [Parameter(Mandatory)] [string]$StateDirectory,
    [string]$NodePath,
    [switch]$Ingress,
    [Parameter(ParameterSetName = 'Register')] [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$')]
    [string]$TaskName = 'OHJingJing Group Service',
    [Parameter(ParameterSetName = 'Register')] [pscredential]$Credential,
    [Parameter(Mandatory, ParameterSetName = 'Run')] [switch]$Run
)

$ErrorActionPreference = 'Stop'
if ($Ingress -and !$PSBoundParameters.ContainsKey('TaskName')) { $TaskName = 'OHJingJing QQ Ingress' }
$program = if ($Ingress) { 'qq-ingress.cjs' } else { 'server.cjs' }
$entry = (Get-Item -LiteralPath (Join-Path $PSScriptRoot $program)).FullName
$configPath = (Get-Item -LiteralPath $Config).FullName
$state = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateDirectory)
$secretsFile = Join-Path $state 'credentials.clixml'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()

if (!$NodePath) {
    $bundledNode = Join-Path $PSScriptRoot 'node.exe'
    $NodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $bundledNode } else {
        (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    }
}
$node = (Get-Item -LiteralPath $NodePath).FullName
$secretLabels = [ordered]@{
    OHJINGJING_ADMIN_TOKEN = 'Group service admin token'
    OHJINGJING_ONEBOT_TOKEN = 'QQ gateway token'
    OHJINGJING_QQ_INGRESS_TOKEN = 'Local QQ ingress token'
    OHJINGJING_MODEL_KEY = 'Reply model API key'
    OHJINGJING_SUMMARY_MODEL_KEY = 'Summary model API key'
    OHJINGJING_GROUP_MODEL_KEYS = 'Group model keys as JSON keyed by group'
    OHJINGJING_BACKUP_MODEL_KEYS = 'Backup model keys as JSON keyed by slot'
    OHJINGJING_MODEL_PROFILE_KEYS = 'Shared model keys as JSON keyed by profile'
    OHJINGJING_QQ_VOICE_KEY = 'QQ voice transcription API key'
    OHJINGJING_QQ_SPEECH_KEY = 'QQ speech synthesis API key'
    OHJINGJING_QQ_PRIVATE_SPEECH_KEY = 'QQ private speech synthesis API key'
}
if ($Ingress) {
    $secretLabels = [ordered]@{
        OHJINGJING_ONEBOT_TOKEN = 'QQ gateway token'
        OHJINGJING_QQ_INGRESS_TOKEN = 'Local QQ ingress token'
    }
}

if ($Run) {
    $stored = Import-Clixml -LiteralPath $secretsFile
    if ($stored -isnot [System.Collections.IDictionary] -or $stored['UserSid'] -ne $identity.User.Value -or
        $stored['Values'] -isnot [System.Collections.IDictionary]) {
        throw 'Open the service task with the Windows account that saved its credentials.'
    }
    foreach ($name in $secretLabels.Keys) {
        $secret = $stored['Values'][$name]
        $value = if ($secret -is [securestring]) { [Net.NetworkCredential]::new('', $secret).Password }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    if (!$Ingress -and $env:OHJINGJING_ADMIN_TOKEN -cnotmatch '\A[A-Za-z0-9_.~-]{24,}\z') {
        throw 'The saved service admin token is invalid.'
    }
    if ($Ingress) { $env:OHJINGJING_QQ_INGRESS_CONFIG = $configPath }
    else { $env:OHJINGJING_CONFIG = $configPath }
    $env:TEMP = $state
    $env:TMP = $state
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OHJingJingWorkerJob
{
    private const int ExtendedLimitInformation = 9;
    private const uint KillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref ExtendedLimits limits, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    public static SafeFileHandle Create()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
        if (SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            return job;
        var error = new Win32Exception(Marshal.GetLastWin32Error());
        job.Dispose();
        throw error;
    }

    public static void Attach(SafeFileHandle job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
    $stdout = Join-Path $state 'server.out.log'
    $stderr = Join-Path $state 'server.error.log'
    $taskLog = Join-Path $state 'task.log'
    $earlyExits = 0
    $job = [OHJingJingWorkerJob]::Create()
    try {
        while ($true) {
            $lifetime = [Diagnostics.Stopwatch]::StartNew()
            $worker = Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $PSScriptRoot `
                -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            try {
                try {
                    [OHJingJingWorkerJob]::Attach($job, $worker.Handle)
                } catch {
                    if (!$worker.HasExited) { $worker.Kill(); throw }
                }
                $worker.WaitForExit()
                $code = $worker.ExitCode
            } finally {
                $worker.Dispose()
            }
            if ($lifetime.Elapsed.TotalMinutes -ge 1) { $earlyExits = 0 } else { $earlyExits++ }
            Add-Content -LiteralPath $taskLog -Value ("{0:O} Worker exited with code {1} after {2:N1}s." -f
                [DateTime]::UtcNow, $code, $lifetime.Elapsed.TotalSeconds)
            if ($earlyExits -ge 10) { throw 'The service failed repeatedly. Check the last startup logs.' }
            Start-Sleep -Seconds 5
        }
    } finally {
        $job.Dispose()
    }
}

if (!([Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
))) { throw 'Register the startup task from an elevated PowerShell.' }
if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
    throw 'A scheduled task with this name already exists.'
}
if (Test-Path -LiteralPath $state) { throw 'Choose a new directory for the task credentials and logs.' }
if (!(Test-Path -LiteralPath (Split-Path -LiteralPath $state) -PathType Container)) {
    throw 'The parent directory for the service task must already exist.'
}
$version = & $node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.20.0') {
    throw 'Node.js 22.20 or newer is required.'
}

if (!$Credential) { $Credential = Get-Credential -UserName $identity.Name -Message 'Windows account for the startup task' }
if (!$Credential) { throw 'A Windows account password is required for startup without interactive sign-in.' }
$account = [Security.Principal.NTAccount]::new($Credential.UserName)
if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
    throw 'The startup task must use the same Windows account that saves its credentials.'
}

$settings = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Ingress) {
    $required = @('OHJINGJING_QQ_INGRESS_TOKEN')
    if ($settings.hasGatewayToken) { $required += 'OHJINGJING_ONEBOT_TOKEN' }
} else {
    $required = @('OHJINGJING_ADMIN_TOKEN')
    if ($settings.channel.enabled -and $settings.channel.hasToken) { $required += 'OHJINGJING_ONEBOT_TOKEN' }
    if ($settings.qqIngress) { $required += 'OHJINGJING_QQ_INGRESS_TOKEN' }
    if ($settings.model.hasKey) { $required += 'OHJINGJING_MODEL_KEY' }
    if ($settings.summaryModel.hasKey) { $required += 'OHJINGJING_SUMMARY_MODEL_KEY' }
    if ($settings.qqVoice.hasKey) { $required += 'OHJINGJING_QQ_VOICE_KEY' }
    if ($settings.qqSpeech.hasKey) { $required += 'OHJINGJING_QQ_SPEECH_KEY' }
    if ($settings.qqPrivateSpeech.hasKey) { $required += 'OHJINGJING_QQ_PRIVATE_SPEECH_KEY' }
    $modelSets = @{
        OHJINGJING_GROUP_MODEL_KEYS = $settings.groupModels
        OHJINGJING_BACKUP_MODEL_KEYS = $settings.backupModels
        OHJINGJING_MODEL_PROFILE_KEYS = $settings.modelProfiles
    }
    foreach ($name in $modelSets.Keys) {
        if ($modelSets[$name].PSObject.Properties.Value | Where-Object { $_.hasKey } | Select-Object -First 1) {
            $required += $name
        }
    }
}
$values = @{}
foreach ($name in $secretLabels.Keys) {
    $inherited = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($inherited) { $values[$name] = ConvertTo-SecureString -String $inherited -AsPlainText -Force }
    elseif ($name -in $required) { $values[$name] = Read-Host $secretLabels[$name] -AsSecureString }
    if ($name -in $required -and !$values[$name].Length) { throw ('Missing credential for ' + $secretLabels[$name]) }
}
if (!$Ingress -and [Net.NetworkCredential]::new('', $values.OHJINGJING_ADMIN_TOKEN).Password -cnotmatch '\A[A-Za-z0-9_.~-]{24,}\z') {
    throw 'The service admin token must be at least 24 URL-safe characters.'
}

$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($sid in $identity.User.Value, 'S-1-5-18', 'S-1-5-32-544') {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inheritance, 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Run -Config "{1}" -StateDirectory "{2}" -NodePath "{3}"' -f
    $PSCommandPath, $configPath, $state, $node
if ($Ingress) { $arguments += ' -Ingress' }
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval ([TimeSpan]::FromMinutes(1)) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

New-Item -ItemType Directory -Path $state | Out-Null
try {
    Set-Acl -LiteralPath $state -AclObject $acl
    @{ UserSid = $identity.User.Value; Values = $values } | Export-Clixml -LiteralPath $secretsFile
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $options `
        -User $identity.Name -Password $Credential.GetNetworkCredential().Password -RunLevel Limited | Out-Null
} catch {
    if (Test-Path -LiteralPath $secretsFile -PathType Leaf) { Remove-Item -LiteralPath $secretsFile }
    if (!(Get-ChildItem -LiteralPath $state -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $state }
    throw
}
Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
Write-Host "Started the task '$TaskName'. Its latest logs are in $state."
