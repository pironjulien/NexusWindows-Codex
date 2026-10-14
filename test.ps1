# Contrôle complet du projet codex-windows-computer-use, hors ligne et sans effet de bord (convention Nexus : test.ps1 à la racine).
$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
Write-Host "Exécution des tests de codex-windows-computer-use..." -ForegroundColor Cyan
node --test (Join-Path $repoRoot "tests\*.test.mjs")
Write-Host "Contrôle réussi (code 0)." -ForegroundColor Green
