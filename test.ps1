# Full offline check: JavaScript unit and integration tests, plus a build of the native helper outside the repository.
# Nothing is written to the source tree, and the tests never touch the real %USERPROFILE%\.nexus folder (a temporary
# shared folder is used instead). Exit code 0 when everything passes.
# -Full also runs, with the freshly built helper: the real foreground-token and emergency-stop tests, then the real
# background validation (tests/live/background.live.mjs), which builds its own WinForms + Win32 + WPF fixture, shows
# its windows without activation and closes them at the end. Steps that need the real foreground only run when you have
# been idle for 120 s; otherwise they are reported as skipped, never as passed.
[CmdletBinding()]
param([switch]$Full)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$work = Join-Path ([IO.Path]::GetTempPath()) ('codex-windows-computer-use-' + [guid]::NewGuid().ToString('N'))
$saved = @{}
foreach ($name in 'NEXUS_SHARED_HOME', 'NEXUS_FOREGROUND_EXE', 'NEXUS_LIVE_EXE', 'NEXUS_LIVE_FIXTURE', 'NEXUS_LIVE_REPORTS') {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    $env:NEXUS_SHARED_HOME = Join-Path $work 'shared'
    New-Item -ItemType Directory -Path $env:NEXUS_SHARED_HOME -Force | Out-Null

    & $node --test @(Get-ChildItem -LiteralPath (Join-Path $root 'tests') -Filter '*.test.mjs' -File | Select-Object -ExpandProperty FullName)
    if ($LASTEXITCODE) { throw 'JavaScript tests failed.' }

    $dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
    $nativeRoot = Join-Path $work 'native'
    & $dotnet publish (Join-Path $root 'native\NexusCodex.UIA.csproj') -c Release -o $nativeRoot `
        "-p:BaseIntermediateOutputPath=$work\build\obj\" "-p:BaseOutputPath=$work\build\bin\" --nologo -v q
    if ($LASTEXITCODE -or -not (Test-Path -LiteralPath (Join-Path $nativeRoot 'NexusCodex.UIA.exe'))) { throw 'Native helper build failed.' }

    if ($Full) {
        $env:NEXUS_FOREGROUND_EXE = Join-Path $nativeRoot 'NexusCodex.UIA.exe'
        & $node --test (Join-Path $root 'tests\foreground.test.mjs') (Join-Path $root 'tests\stop.test.mjs')
        if ($LASTEXITCODE) { throw 'Foreground token or emergency stop tests failed.' }

        $fixtureRoot = Join-Path $work 'fixture'
        & $dotnet build (Join-Path $root 'tests\live\NexusCodex.LiveFixture.csproj') -c Release -o $fixtureRoot `
            "-p:BaseIntermediateOutputPath=$work\fixture-build\obj\" "-p:BaseOutputPath=$work\fixture-build\bin\" --nologo -v q
        if ($LASTEXITCODE) { throw 'Live fixture build failed.' }
        $env:NEXUS_LIVE_EXE = $env:NEXUS_FOREGROUND_EXE
        $env:NEXUS_LIVE_FIXTURE = Join-Path $fixtureRoot 'NexusCodex.LiveFixture.exe'
        $env:NEXUS_LIVE_REPORTS = Join-Path $work 'reports'
        & $node --test (Join-Path $root 'tests\live\background.live.mjs')
        if ($LASTEXITCODE) { throw 'Live background validation failed.' }
    }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host 'All checks passed.'
exit 0
