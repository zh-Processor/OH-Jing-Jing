param(
    [Parameter(Mandatory)][string]$SettingsPath,
    [Parameter(Mandatory)][string]$CandidatePath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath | ConvertFrom-Json
$candidate = Get-Content -Raw -Encoding UTF8 -LiteralPath $CandidatePath | ConvertFrom-Json
$job = Split-Path -Parent (Resolve-Path -LiteralPath $CandidatePath).Path
$root = (Resolve-Path -LiteralPath $settings.installDirectory).Path
$entry = Join-Path $root 'server.cjs'
$statePath = Join-Path $root 'development-release.json'
$lockPath = Join-Path $root 'development-release.lock'
$result = Join-Path $job 'release-result.json'
$address = [Uri]::new([string]$settings.serviceAddress)

if ($candidate.target -cne $settings.target -or [string]$settings.taskName -cnotmatch '^OHJingJing .+ Test(?: Server)?$' -or
    $address.Scheme -ne 'http' -or !$address.IsLoopback -or $address.AbsolutePath -ne '/' -or $address.Query -or $address.Fragment -or
    $address.UserInfo -or $candidate.version -cnotmatch '^[a-f0-9]{64}$' -or $candidate.taskId -cnotmatch '^[a-f0-9-]{36}$') {
    throw 'Invalid test instance or candidate.'
}
$artifact = (Resolve-Path -LiteralPath $candidate.artifact).Path
if ((Split-Path -Parent $artifact) -ine $job -or (Split-Path -Leaf $artifact) -cne 'candidate.cjs') {
    throw 'Candidate is outside its job directory.'
}
if ((Get-FileHash -LiteralPath $artifact).Hash -ine $candidate.version) { throw 'Candidate digest mismatch.' }
$task = Get-ScheduledTask -TaskName $settings.taskName
$taskRoot = $root.TrimEnd('\') + '\'
if (!($task.Actions | Where-Object { $_.WorkingDirectory -ieq $root -or
      ([string]$_.Arguments).IndexOf($taskRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
    throw 'The scheduled task must point to this test installation.'
}

$probeHeaders = @{}
if ($settings.requireQQ -eq $true -or $settings.requireIngress -eq $true) {
    $secure = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath (Join-Path $root 'admin-token.dpapi')).Trim())
    $probeHeaders.Authorization = 'Bearer ' + [Net.NetworkCredential]::new('', $secure).Password
}

function Test-Readiness([string]$Phase = 'active') {
    $base = $address.AbsoluteUri.TrimEnd('/')
    try {
        $health = Invoke-RestMethod "$base/health" -TimeoutSec 3
        if ($health.ok -ne $true) { return $false }
        if ($settings.requireQQ -eq $true) {
            $status = Invoke-RestMethod "$base/admin/gateway" -Headers $probeHeaders -TimeoutSec 4
            if ($status.connection -ne 'online' -or $status.login.status -ne 'confirmed' -or $status.matchesExpected -ne $true) { return $false }
        }
        if ($settings.requireIngress -eq $true) {
            $status = Invoke-RestMethod "$base/admin/qq-ingress" -Headers $probeHeaders -TimeoutSec 4
            if ($status.ready -ne $true -or $status.missed -eq $true -or $status.holdSupported -ne $true) { return $false }
            $held = $status.paused -eq $true -and $status.holdId -ceq $candidate.taskId
            $active = $status.paused -eq $false -and !$status.holdId
            if ($Phase -eq 'held') { return $held }
            if ($Phase -eq 'either') { return $held -or $active }
            return $active
        }
        return $true
    } catch { return $false }
}

function Wait-Ready([string]$Phase = 'active') {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(50)
    $consecutive = 0
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if (Test-Readiness $Phase) { $consecutive++ } else { $consecutive = 0 }
        if ($consecutive -ge 3) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Stop-TestTask {
    Stop-ScheduledTask -TaskName $settings.taskName
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(18)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $listener = Get-NetTCPConnection -LocalPort $address.Port -State Listen -ErrorAction SilentlyContinue
        if ((Get-ScheduledTask -TaskName $settings.taskName).State -notin @('Running','Queued') -and !$listener) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'The test entry is still active.'
}

function Save-Result([string]$state, [string]$report) {
    $output = @{ state = $state; report = $report; version = $candidate.version } | ConvertTo-Json -Compress
    $next = "$result.next"
    [IO.File]::WriteAllText($next, $output, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($next, $result)
}

function Write-DeployedVersion([string]$version, [string]$taskId) {
    $nextState = Join-Path $root ('development-release-' + $candidate.taskId + '.next')
    [IO.File]::WriteAllText($nextState, (@{ version = $version; task = $taskId } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $statePath) {
        [IO.File]::Replace($nextState, $statePath, (Join-Path $root 'development-release.previous.json'), $true)
    }
    else { [IO.File]::Move($nextState, $statePath) }
}

function Start-TestTaskIfStopped {
    if ((Get-ScheduledTask -TaskName $settings.taskName).State -notin @('Running','Queued')) {
        Start-ScheduledTask -TaskName $settings.taskName
    }
}

function Set-TestIntake([string]$Action) {
    if ($settings.requireIngress -ne $true) { return }
    $base = $address.AbsoluteUri.TrimEnd('/')
    $state = Invoke-RestMethod "$base/admin/qq-ingress/$Action" -Headers $probeHeaders -Method Post -TimeoutSec 30 `
        -ContentType 'application/json' -Body (@{holdId=$candidate.taskId} | ConvertTo-Json -Compress)
    if ($Action -eq 'drain' -and ($state.drained -ne $true -or $state.holdId -cne $candidate.taskId)) {
        throw 'The test intake did not persist the release hold.'
    }
    if ($Action -eq 'resume' -and ($state.paused -ne $false -or $state.holdId)) { throw 'The test intake did not release the hold.' }
}

function Test-ReleaseProtocol {
    if ($settings.requireIngress -ne $true) { return }
    $runtime = Join-Path $root 'node.exe'
    if (!(Test-Path -LiteralPath $runtime -PathType Leaf)) { $runtime = (Get-Command node.exe -CommandType Application).Source }
    $start = [Diagnostics.ProcessStartInfo]::new($runtime, ('"' + $artifact + '" --release-capabilities'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $job
    foreach ($key in @($start.EnvironmentVariables.Keys)) {
        if ($key -ilike 'OHJINGJING_*') { $start.EnvironmentVariables.Remove($key) }
    }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(6000)) {
            $process.Kill()
            throw 'The candidate release protocol check timed out.'
        }
        if ($process.ExitCode -ne 0 -or ($stdout.GetAwaiter().GetResult() | ConvertFrom-Json).qqIngressHold -ne 1) {
            throw 'The candidate does not support persistent intake handoff.'
        }
    } finally { $process.Dispose() }
}

function Confirm-TestActivation([bool]$Recovering, [bool]$Restoring = $false) {
    Start-TestTaskIfStopped
    if ($settings.requireIngress -eq $true) {
        if ($Recovering -or $Restoring) {
            if (!(Wait-Ready 'either')) { return $false }
            if (Test-Readiness) {
                if ($Restoring) { return $true }
                Set-TestIntake 'drain'
            }
        }
        if (!(Wait-Ready 'held')) { return $false }
        Set-TestIntake 'resume'
    }
    return (Wait-Ready)
}

$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    if (Test-Path -LiteralPath $result) {
        $completed = Get-Content -Raw -Encoding UTF8 -LiteralPath $result | ConvertFrom-Json
        if ($completed.version -cne $candidate.version -or $completed.state -cnotin @('published','rolled-back','failed')) {
            throw 'The previous release result could not be verified.'
        }
        return
    }
    $active = (Get-FileHash -LiteralPath $entry).Hash.ToLowerInvariant()
    $deployed = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    $expected = if ($deployed) { $deployed.version } else { $settings.initialVersion }
    $stage = Join-Path $root ('candidate-' + $candidate.taskId + '.next')
    $backup = Join-Path $root ('baseline-' + $candidate.taskId + '.cjs')
    $failed = Join-Path $root ('failed-' + $candidate.taskId + '.cjs')
    if ($expected -cnotmatch '^[a-f0-9]{64}$') { throw 'The expected test version is invalid.' }

    if ($deployed.task -ceq $candidate.taskId -and $active -ceq $expected -and $active -ceq $candidate.version) {
        Start-TestTaskIfStopped
        if (!(Wait-Ready)) { throw 'The previously confirmed candidate is currently unhealthy.' }
        Save-Result 'published' '已恢复发布回执，测试实例健康。'
        return
    }

    $hasBackup = Test-Path -LiteralPath $backup -PathType Leaf
    if ($hasBackup -and ($active -cne $candidate.version -or (Get-FileHash -LiteralPath $backup).Hash -ine $expected)) {
        throw 'The interrupted release could not be matched to its verified rollback artifact.'
    }
    if (!$hasBackup -and $active -cne $expected) { throw 'The active test version changed outside this release.' }
    if (Test-Path -LiteralPath $failed -PathType Leaf) {
        if ($hasBackup -or (Get-FileHash -LiteralPath $failed).Hash -ine $candidate.version) {
            throw 'The restored release could not be matched to its rejected candidate.'
        }
        if (!(Confirm-TestActivation $true $true)) { throw 'The restored baseline is currently unhealthy.' }
        Write-DeployedVersion $active $candidate.taskId
        Save-Result 'rolled-back' '已恢复回滚回执，上一版本健康。'
        return
    }

    $switched = $hasBackup
    try {
        if (!$switched) {
            Test-ReleaseProtocol
            $resuming = Test-Path -LiteralPath $stage -PathType Leaf
            if (!$resuming -and !(Test-Readiness 'either')) { throw 'The current test baseline failed its health check.' }
            if (!$resuming -or (Get-FileHash -LiteralPath $stage).Hash -ine $candidate.version) {
                Copy-Item -LiteralPath $artifact -Destination $stage -Force
            }
            if ((Get-FileHash -LiteralPath $stage).Hash -ine $candidate.version) { throw 'Staged candidate digest mismatch.' }
            if ((Get-ScheduledTask -TaskName $settings.taskName).State -in @('Running','Queued')) {
                Set-TestIntake 'drain'
                Stop-TestTask
            }
            if (Get-NetTCPConnection -LocalPort $address.Port -State Listen -ErrorAction SilentlyContinue) {
                throw 'The test port is still active after the managed task stopped.'
            }
            [IO.File]::Replace($stage, $entry, $backup, $true)
            $switched = $true
        }
        if (!(Confirm-TestActivation $hasBackup)) { throw 'Candidate test health check failed.' }
        Write-DeployedVersion $candidate.version $candidate.taskId
    } catch {
        if ($switched) {
            if ((Get-ScheduledTask -TaskName $settings.taskName).State -in @('Running','Queued')) {
                try { Set-TestIntake 'drain' } catch { }
                Stop-TestTask
            }
            if ((Get-FileHash -LiteralPath $backup).Hash -ine $expected) { throw 'The rollback artifact failed verification.' }
            [IO.File]::Replace($backup, $entry, $failed, $true)
            if (!(Confirm-TestActivation $true $true)) { throw 'The previous version was restored but is unhealthy.' }
            Write-DeployedVersion $expected $candidate.taskId
            Save-Result 'rolled-back' '候选未通过健康检查，已恢复上一版本。'
        } else {
            Start-TestTaskIfStopped
            try { Set-TestIntake 'resume' } catch { }
            Save-Result 'failed' '发布未切换现有版本。'
        }
        return
    }
    Save-Result 'published' '测试实例已通过连续健康检查。'
} finally { $lock.Dispose() }
