[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Installer,
    [string]$PreviousInstaller,
    [string]$WorkDirectory,
    [string]$SevenZip = (Join-Path $env:ProgramFiles '7-Zip\7z.exe')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (!$WorkDirectory) { $WorkDirectory = Join-Path $repo '.work\installer-tests' }
$installerPath = (Get-Item -LiteralPath $Installer).FullName
$previousPath = if ($PreviousInstaller) { (Get-Item -LiteralPath $PreviousInstaller).FullName }
if (-not (Test-Path -LiteralPath $SevenZip -PathType Leaf)) {
    $SevenZip = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop).Source
}
if ($previousPath -and (Get-FileHash -LiteralPath $previousPath).Hash -eq (Get-FileHash -LiteralPath $installerPath).Hash) {
    throw 'Use distinct installers when testing an upgrade.'
}

$workRoot = (New-Item -Path $WorkDirectory -ItemType Directory -Force).FullName
$scratch = (New-Item -Path (Join-Path $workRoot ([guid]::NewGuid().ToString('N'))) -ItemType Directory).FullName
$environment = 'TEMP', 'TMP', 'OHJINGJING_TEST_DESKTOP_PACKAGE', 'OHJINGJING_TEST_PREVIOUS_DESKTOP_PACKAGE'
$saved = @{}
foreach ($name in $environment) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

function Confirm-PortableExecutable([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Missing executable header in $Path" }
        $stream.Position = 0x3C
        $stream.Position = $reader.ReadUInt32()
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
            throw "Expected an x64 Windows executable at $Path"
        }
    } finally { $reader.Dispose() }
}

function Extract-Package([string]$PackagePath, [string]$Label) {
    $listing = & $SevenZip l -slt $PackagePath
    if ($LASTEXITCODE -ne 0 -or $listing -notcontains 'Type = Nsis') { throw "Expected an NSIS installer at $PackagePath" }
    $destination = (New-Item -Path (Join-Path $scratch $Label) -ItemType Directory).FullName
    $files = 'ohjingjing.exe', 'node.exe', 'runtime.mjs'
    & $SevenZip x $PackagePath "-o$destination" @files -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $PackagePath" }
    foreach ($file in $files) {
        $entry = Get-Item -LiteralPath (Join-Path $destination $file)
        if ($entry.PSIsContainer -or $entry.Length -eq 0) { throw "Missing payload $file in $PackagePath" }
    }
    Confirm-PortableExecutable (Join-Path $destination 'ohjingjing.exe')
    $node = Join-Path $destination 'node.exe'
    Confirm-PortableExecutable $node
    $version = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.20.0') { throw 'Packaged Node.js must be at least 22.20.' }
    Write-Host "$Label installer payload verified (Node.js $version)."
    return $destination
}

Push-Location -LiteralPath $repo
try {
    $env:TEMP = $scratch
    $env:TMP = $scratch
    $env:OHJINGJING_TEST_DESKTOP_PACKAGE = Extract-Package $installerPath 'Current'
    $env:OHJINGJING_TEST_PREVIOUS_DESKTOP_PACKAGE = if ($previousPath) { Extract-Package $previousPath 'Previous' }
    $node = Join-Path $env:OHJINGJING_TEST_DESKTOP_PACKAGE 'node.exe'
    & $node --import tsx --test tests/desktop.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Installer payload tests failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
    foreach ($name in $environment) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    $absoluteScratch = (Resolve-Path -LiteralPath $scratch).Path
    $absoluteRoot = (Resolve-Path -LiteralPath $workRoot).Path.TrimEnd('\') + '\'
    if (-not $absoluteScratch.StartsWith($absoluteRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer test scratch directory escaped the selected work directory.'
    }
    Remove-Item -LiteralPath $absoluteScratch -Recurse -Force
}
