[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [string[]]$PiArguments = @()
)

$ErrorActionPreference = 'Stop'
$node = Join-Path $PSScriptRoot 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
}

$cliPath = 'pi-workspace/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
$cli = Join-Path $PSScriptRoot $cliPath
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    $cli = Join-Path (Split-Path $PSScriptRoot -Parent) $cliPath
}
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'Pi is missing. Run npm --prefix pi-workspace ci --ignore-scripts from the release or repository directory.'
}

$workspacePath = (Resolve-Path -LiteralPath $Workspace).ProviderPath
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be a directory.' }
$profile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDirectory)
$temporary = Join-Path $profile 'tmp'
$null = New-Item -ItemType Directory -Force -Path $temporary
$names = @('PI_CODING_AGENT_DIR', 'TEMP', 'TMP', 'TMPDIR', 'NPM_CONFIG_CACHE')
$names += @(Get-ChildItem Env: | Where-Object Name -like 'OHJINGJING_*' | Select-Object -ExpandProperty Name)
$original = @{}
foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

Push-Location -LiteralPath $workspacePath
try {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $env:PI_CODING_AGENT_DIR = $profile
    $env:TEMP = $env:TMP = $env:TMPDIR = $temporary
    $env:NPM_CONFIG_CACHE = Join-Path $profile 'npm-cache'
    & $node $cli @PiArguments
    if ($LASTEXITCODE -ne 0) { throw "Pi exited with status $LASTEXITCODE." }
} finally {
    Pop-Location
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
}
