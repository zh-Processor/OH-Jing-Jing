param(
    [Parameter(Mandatory)][string]$LibraryDirectory,
    [Parameter(Mandatory)][string]$ModelDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$library = (Resolve-Path -LiteralPath $LibraryDirectory).Path
$model = (Resolve-Path -LiteralPath $ModelDirectory).Path
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$dlls = @('libvosk.dll', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll')
foreach ($name in $dlls) {
    if (!(Test-Path -LiteralPath (Join-Path $library $name) -PathType Leaf)) {
        throw "Missing the Windows recognition library $name."
    }
}
if (!(Test-Path -LiteralPath (Join-Path $model 'am\final.mdl') -PathType Leaf)) {
    throw 'Choose an extracted speech recognition model directory.'
}

$framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$serialization = Join-Path $framework 'System.Web.Extensions.dll'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf) -or !(Test-Path -LiteralPath $serialization -PathType Leaf)) {
    throw 'The 64-bit Windows .NET Framework compiler is required.'
}
if (Test-Path -LiteralPath $output) { throw 'Choose a new output directory.' }
$null = New-Item -ItemType Directory -Path $output
$worker = Join-Path $output 'OHJingJing-transcriber.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/reference:$serialization" "/out:$worker" (Join-Path $PSScriptRoot 'windows-transcription-worker.cs')
if ($LASTEXITCODE -ne 0) { throw 'The Windows recognition worker could not be built.' }
foreach ($name in $dlls) { Copy-Item -LiteralPath (Join-Path $library $name) -Destination $output }
Copy-Item -LiteralPath $model -Destination (Join-Path $output 'model') -Recurse
Write-Output $worker
