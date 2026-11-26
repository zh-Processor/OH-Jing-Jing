[CmdletBinding()]
param(
    [string]$Config = (Join-Path $PSScriptRoot 'server.config.json')
)

$ErrorActionPreference = 'Stop'
$nodePath = Join-Path $PSScriptRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { throw 'Node.js 22.20 or newer is required.' }
    $nodePath = $node.Source
}
$nodeVersion = & $nodePath -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.20.0') {
    throw 'Node.js 22.20 or newer is required.'
}

$entry = Join-Path $PSScriptRoot 'server.cjs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'server.cjs was not found beside this launcher.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'server.config.example.json') -Destination $Config
    Write-Host 'Created a config from the example. QQ is disabled until you enable it.'
}
$configPath = (Resolve-Path -LiteralPath $Config).Path
$configData = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Read-ProcessSecret([string]$name, [string]$label) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { return }
    $secure = Read-Host $label -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $secure.Dispose()
    }
}

$names = @('OHJINGJING_CONFIG', 'OHJINGJING_ADMIN_TOKEN', 'OHJINGJING_ONEBOT_TOKEN', 'OHJINGJING_QQ_INGRESS_TOKEN',
    'OHJINGJING_MODEL_KEY', 'OHJINGJING_SUMMARY_MODEL_KEY', 'OHJINGJING_BACKUP_MODEL_KEYS', 'OHJINGJING_MODEL_PROFILE_KEYS',
    'OHJINGJING_QQ_VOICE_KEY', 'OHJINGJING_QQ_SPEECH_KEY', 'OHJINGJING_QQ_PRIVATE_SPEECH_KEY')
$original = @{}
foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

try {
    $env:OHJINGJING_CONFIG = $configPath
    Read-ProcessSecret 'OHJINGJING_ADMIN_TOKEN' 'Local admin token (24 or more URL-safe characters)'
    if ($configData.qqIngress) { Read-ProcessSecret 'OHJINGJING_QQ_INGRESS_TOKEN' 'Local QQ ingress token' }
    if ($configData.backupModels -and @($configData.backupModels.PSObject.Properties.Value | Where-Object { $_.hasKey }).Count) {
        Read-ProcessSecret 'OHJINGJING_BACKUP_MODEL_KEYS' 'Backup API keys as JSON keyed by model slot'
    }
    if ($configData.modelProfiles -and @($configData.modelProfiles.PSObject.Properties.Value | Where-Object { $_.hasKey }).Count) {
        Read-ProcessSecret 'OHJINGJING_MODEL_PROFILE_KEYS' 'Shared model API keys as JSON keyed by profile ID'
    }
    if ($configData.channel.enabled) {
        if ($configData.channel.hasToken) { Read-ProcessSecret 'OHJINGJING_ONEBOT_TOKEN' 'OneBot token' }
        if ($configData.model.hasKey) { Read-ProcessSecret 'OHJINGJING_MODEL_KEY' 'Reply model API key' }
        if ($configData.summaryModel.hasKey) { Read-ProcessSecret 'OHJINGJING_SUMMARY_MODEL_KEY' 'Summary model API key' }
        if ($configData.qqVoice.hasKey) { Read-ProcessSecret 'OHJINGJING_QQ_VOICE_KEY' 'QQ voice transcription API key' }
        if ($configData.qqSpeech.hasKey) { Read-ProcessSecret 'OHJINGJING_QQ_SPEECH_KEY' 'QQ speech synthesis API key' }
        if ($configData.qqPrivateSpeech.hasKey) { Read-ProcessSecret 'OHJINGJING_QQ_PRIVATE_SPEECH_KEY' 'QQ private speech synthesis API key' }
    }
    & $nodePath $entry
    if ($LASTEXITCODE -ne 0) { throw "Server exited with status $LASTEXITCODE." }
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
}
