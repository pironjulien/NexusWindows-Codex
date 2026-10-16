# Builds the native UI Automation helper and installs the `nexus-windows` skill for Codex.
# Safe to re-run: builds are versioned by source fingerprint under the state folder, the skill is rewritten only when
# it differs, and a cross-process lock prevents two simultaneous installations.
#   pwsh -NoProfile -File install.ps1              install or update
#   pwsh -NoProfile -File install.ps1 -CheckOnly   verify that the installation matches these sources (changes nothing)
# Requires the .NET 8 SDK (dotnet). No npm or Python package is installed.
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'NexusCodex\ComputerUse'),
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$stateRoot = [IO.Path]::GetFullPath($StateRoot)
$skillTarget = Join-Path $CodexHome 'skills\nexus-windows'
$skillSource = Join-Path $sourceRoot 'skill\nexus-windows'
$manifestPath = Join-Path $stateRoot 'installation.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$requiredArtifacts = 'NexusCodex.UIA.exe', 'NexusCodex.UIA.dll', 'NexusCodex.UIA.deps.json', 'NexusCodex.UIA.runtimeconfig.json'

function Get-CombinedHash([string[]]$Files) {
    $lines = foreach ($file in ($Files | Sort-Object)) {
        ([IO.Path]::GetRelativePath($sourceRoot, $file)) + ':' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lines -join "`n"))).ToLowerInvariant()
}

function Write-AtomicText([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = Join-Path $parent ('.nexus-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Content, $utf8)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Test-NativeArtifacts([string]$NativeRoot, $Artifacts) {
    # A matching EXE is not enough: the .NET host needs all four runtime files, each with its recorded hash.
    if ($Artifacts -isnot [System.Collections.IDictionary]) { return $false }
    foreach ($required in $requiredArtifacts) { if (-not $Artifacts.Contains($required)) { return $false } }
    foreach ($name in $Artifacts.Keys) {
        $hash = $Artifacts[$name]
        if ($name -in '.', '..' -or $name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
            $hash -isnot [string] -or $hash -cnotmatch '^[a-fA-F0-9]{64}$') { return $false }
        $file = Join-Path $NativeRoot $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $hash) { return $false }
    }
    return $true
}

$lockKey = $stateRoot.TrimEnd('\', '/').ToUpperInvariant()
$lockHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lockKey)))
$installLock = [Threading.Mutex]::new($false, 'Local\NexusCodex-ComputerUse-' + $lockHash)
$acquired = $false
try {
    try { $acquired = $installLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another Computer Use installation is already running.' }

    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | Where-Object {
            $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.Extension -in '.mjs', '.cs', '.csproj', '.md', '.json'
        } | Select-Object -ExpandProperty FullName)
    $nativeFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'native') -File | Select-Object -ExpandProperty FullName)
    $sourceHash = Get-CombinedHash $sourceFiles
    $nativeHash = Get-CombinedHash $nativeFiles
    $nativeRoot = Join-Path $stateRoot "native\$nativeHash"
    $nativeExe = Join-Path $nativeRoot 'NexusCodex.UIA.exe'
    $manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable } else { $null }

    # Native output is versioned and local, so a running helper is never replaced in place.
    $nativeValid = $manifest -is [System.Collections.IDictionary] -and $manifest['Schema'] -eq 1 -and
        $manifest['NativeHash'] -eq $nativeHash -and (Test-NativeArtifacts $nativeRoot $manifest['NativeArtifacts'])
    if (-not $nativeValid) {
        if ($CheckOnly) { throw 'Native helper missing or different from the sources: run install.ps1.' }
        $dotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
        $buildRoot = Join-Path $stateRoot "build\$nativeHash"
        & $dotnet publish (Join-Path $sourceRoot 'native\NexusCodex.UIA.csproj') -c Release -o $nativeRoot `
            "-p:BaseIntermediateOutputPath=$buildRoot\obj\" "-p:BaseOutputPath=$buildRoot\bin\" --nologo
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nativeExe)) { throw 'Native helper build failed.' }
    }

    # The skill's entry point links to these sources (no copied SDK).
    $moduleUrl = ([uri](Join-Path $sourceRoot 'lib\session.mjs')).AbsoluteUri | ConvertTo-Json -Compress
    $nativeModuleUrl = ([uri](Join-Path $sourceRoot 'lib\native.mjs')).AbsoluteUri | ConvertTo-Json -Compress
    $stopModuleUrl = ([uri](Join-Path $sourceRoot 'lib\stop.mjs')).AbsoluteUri | ConvertTo-Json -Compress
    $stateLiteral = $stateRoot | ConvertTo-Json -Compress
    $exeLiteral = $nativeExe | ConvertTo-Json -Compress
    $entry = @"
// Generated by install.ps1. Source-linked; no copied SDK.
import { WindowsSession, summarize } from $moduleUrl;
import { NativeUIA } from $nativeModuleUrl;
import { emergencyStop } from $stopModuleUrl;
export { summarize };
export function createWindowsSession(sky) {
  // Shared emergency stop: one file watcher and one Ctrl+Alt+Shift+Esc guard per REPL process.
  const stop = emergencyStop();
  stop.startGuard($exeLiteral);
  return new WindowsSession(sky, {stateRoot: $stateLiteral, native: new NativeUIA($exeLiteral, {emergencyStop: stop}), emergencyStop: stop});
}
"@
    $expectedFiles = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $skillSource -Recurse -File)) {
        $relative = [IO.Path]::GetRelativePath($skillSource, $file.FullName)
        $expectedFiles[(Join-Path $skillTarget $relative)] = [IO.File]::ReadAllText($file.FullName)
    }
    $expectedFiles[(Join-Path $skillTarget 'entry.mjs')] = $entry
    foreach ($target in $expectedFiles.Keys) {
        $current = if (Test-Path -LiteralPath $target) { [IO.File]::ReadAllText($target) } else { $null }
        if ($current -cne $expectedFiles[$target]) {
            if ($CheckOnly) { throw "Skill not aligned with the sources: $target" }
            Write-AtomicText $target $expectedFiles[$target]
        }
    }

    if ($CheckOnly) {
        if (-not $manifest -or $manifest['SourceHash'] -ne $sourceHash -or $manifest['SourceRoot'] -cne $sourceRoot -or
            $manifest['NativeExecutable'] -cne $nativeExe -or $manifest['Skill'] -cne $skillTarget) { throw 'Installation manifest not aligned.' }
    } else {
        $artifacts = [ordered]@{}
        foreach ($file in (Get-ChildItem -LiteralPath $nativeRoot -File)) { $artifacts[$file.Name] = (Get-FileHash -LiteralPath $file.FullName).Hash }
        Write-AtomicText $manifestPath ([ordered]@{
                Schema = 1; SourceRoot = $sourceRoot; SourceHash = $sourceHash; NativeHash = $nativeHash
                NativeArtifacts = $artifacts; Skill = $skillTarget; NativeExecutable = $nativeExe
            } | ConvertTo-Json -Depth 5)
    }
    Write-Host "Computer Use for Codex: sources, skill and native helper aligned ($skillTarget)."
} finally {
    if ($acquired) { $installLock.ReleaseMutex() }
    $installLock.Dispose()
}
