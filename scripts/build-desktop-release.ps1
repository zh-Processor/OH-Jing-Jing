param(
    [Parameter(Mandatory)][string]$Endpoint,
    [Parameter(Mandatory)][string]$PublicKeyFile,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Version,
    [switch]$Offline,
    [switch]$DesktopHarness,
    [ValidateSet('zlib','bzip2','lzma')][string]$InstallerCompression,
    [switch]$AllowLoopbackTest
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$feed = [Uri]::new($Endpoint)
$allowHttp = $AllowLoopbackTest -and $feed.IsLoopback -and $feed.Scheme -eq 'http'
if (!$feed.IsAbsoluteUri -or ($feed.Scheme -ne 'https' -and !$allowHttp) -or $feed.UserInfo -or $feed.Fragment -or
    $feed.Query -or $feed.Segments[-1] -cne 'latest.json') { throw 'The update endpoint must be the trusted latest.json URL.' }
if (!$env:TAURI_SIGNING_PRIVATE_KEY) { throw 'Set TAURI_SIGNING_PRIVATE_KEY for the configured release key.' }

function New-DesktopHarnessArchive([string]$Modules, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entries = Get-ChildItem -LiteralPath $Modules -Force
        foreach ($entry in $entries) {
            if ($entry.Name -in @('.bin', '.package-lock.json', 'node-win-x64')) { continue }
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A desktop dependency is a filesystem link.' }
            $files = if ($entry.PSIsContainer) { Get-ChildItem -LiteralPath $entry.FullName -File -Recurse -Force } else { $entry }
            foreach ($file in $files) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A desktop dependency is a filesystem link.' }
                $relative = 'node_modules/' + $file.FullName.Substring($Modules.Length + 1).Replace('\', '/')
                $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zip, $file.FullName, $relative, [IO.Compression.CompressionLevel]::NoCompression)
            }
        }
    } finally {
        $zip.Dispose()
    }
}

$publicKey = (Get-Content -Raw -LiteralPath $PublicKeyFile -Encoding UTF8).Trim()
if (!$publicKey) { throw 'The update public key file is empty.' }
$directory = New-Item -ItemType Directory -Path $OutputDirectory -Force
$utf8 = [Text.UTF8Encoding]::new($false)
$overlay = Join-Path $directory.FullName 'tauri.signed-updater.json'
$updater = @{ pubkey=$publicKey; endpoints=@($feed.AbsoluteUri); requireSignedVersion=$true;
    windows=@{installMode='passive'} }
if ($allowHttp) { $updater.dangerousInsecureTransportProtocol = $true }
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$versionToBuild = if ($Version) { $Version } else { $config.version }
if ($versionToBuild -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric desktop release version.' }
$bundleOptions = @{createUpdaterArtifacts=$true; useLocalToolsDir=$true}
$windows = @{}
if ($Offline) { $windows.webviewInstallMode = @{type='offlineInstaller'; silent=$true} }
if ($DesktopHarness) {
    $modules = Join-Path $project 'dsh-runtime/node_modules'
    foreach ($file in @('node-win-x64/bin/node.exe','@deepseek-ai/dsh-sdk-client/lib/index.js','@deepseek-ai/dsh/lib/bin.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $modules $file) -PathType Leaf)) {
            throw 'Install the locked dsh-runtime dependencies before building the desktop runtime pilot.'
        }
    }
    $windows.nsis = @{installerHooks='nsis/desktop-harness.nsh'}
}
if ($InstallerCompression) {
    if (!$windows.nsis) { $windows.nsis = @{} }
    $windows.nsis.compression = $InstallerCompression
}
if ($windows.Count) { $bundleOptions.windows = $windows }
[IO.File]::WriteAllText($overlay, (@{version=$versionToBuild;bundle=$bundleOptions; plugins=@{updater=$updater}} |
    ConvertTo-Json -Depth 6), $utf8)

$priorHarnessBuild = $env:OHJINGJING_BUNDLE_DSH
$priorHarnessPayload = $env:OHJINGJING_DESKTOP_HARNESS_BUNDLE
$env:OHJINGJING_BUNDLE_DSH = if ($DesktopHarness) { '1' } else { $null }
$payload = $null
Push-Location -LiteralPath $project
try {
    if ($DesktopHarness) {
        $payload = New-Item -ItemType Directory -Path (Join-Path $directory.FullName ('harness-payload-' + [Guid]::NewGuid().ToString('N')))
        $archive = Join-Path $payload.FullName 'desktop-sdk.zip'
        $extractor = Join-Path $payload.FullName 'desktop-harness-package.mjs'
        $packageScript = Join-Path $project 'scripts\desktop-harness-package.mjs'
        New-DesktopHarnessArchive $modules $archive
        $extractorOptions = @('--bundle', '--platform=node', '--format=esm', '--target=node24', '--log-level=warning', "--outfile=$extractor")
        & (Join-Path $project 'node_modules\.bin\esbuild.cmd') $packageScript @extractorOptions
        if ($LASTEXITCODE -ne 0) { throw 'Could not bundle the desktop runtime installer.' }
        $env:OHJINGJING_DESKTOP_HARNESS_BUNDLE = $payload.FullName
    }
    & (Join-Path $project 'node_modules\.bin\tauri.cmd') build --config $overlay
    if ($LASTEXITCODE -ne 0) { throw "Tauri exited with status $LASTEXITCODE" }
    $bundle = Join-Path $(if ($env:CARGO_TARGET_DIR) {$env:CARGO_TARGET_DIR} else {Join-Path $project 'src-tauri\target'}) 'release\bundle\nsis'
    $installers = @(Get-ChildItem -LiteralPath $bundle -File -Filter "*_${versionToBuild}_x64-setup.exe")
    if ($installers.Count -ne 1) { throw 'Could not identify exactly one installer for the configured version.' }
    $installer = $installers[0]
    $signature = Get-Content -Raw -Encoding UTF8 -LiteralPath ($installer.FullName + '.sig')
    if (!$signature.Trim()) { throw 'The installer signature is empty.' }
    $url = [Uri]::new($feed, $installer.Name)
    $release = @{ version=$versionToBuild; platforms=@{'windows-x86_64'=@{url=$url.AbsoluteUri; signature=$signature.Trim()}} }
    Copy-Item -LiteralPath $installer.FullName -Destination $directory.FullName
    Copy-Item -LiteralPath ($installer.FullName + '.sig') -Destination $directory.FullName
    [IO.File]::WriteAllText((Join-Path $directory.FullName 'latest.json'), ($release | ConvertTo-Json -Depth 6), $utf8)
} finally {
    Pop-Location
    $env:OHJINGJING_BUNDLE_DSH = $priorHarnessBuild
    $env:OHJINGJING_DESKTOP_HARNESS_BUNDLE = $priorHarnessPayload
    if ($payload) {
        Remove-Item -LiteralPath $archive,$extractor -ErrorAction SilentlyContinue
        if (!(Get-ChildItem -LiteralPath $payload.FullName -Force)) { Remove-Item -LiteralPath $payload.FullName }
    }
}
