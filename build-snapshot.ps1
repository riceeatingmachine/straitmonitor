# Windows entry point for the same validated builder used by GitHub Actions.
# Requires Node.js 24. No provider keys are needed.
$ErrorActionPreference = 'Stop'
$builderPath = Join-Path $PSScriptRoot 'scripts/build-data.mjs'
& node $builderPath
exit $LASTEXITCODE
