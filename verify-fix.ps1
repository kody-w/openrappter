Set-Location "C:\Users\kowildfe\Documents\GitHub\openrappter\typescript"

# Clean dist without rm (Windows-safe)
if (Test-Path dist) { Remove-Item -Recurse -Force dist }

# Compile
npx tsc
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nBuild failed." -ForegroundColor Red
    exit 1
}

Write-Host "`nBuild succeeded. Installing globally..." -ForegroundColor Green

# Reinstall globally from local build so 'openrappter' picks up the fix
npm install -g .
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nGlobal install failed." -ForegroundColor Red
    exit 1
}

Write-Host "`nRunning onboard...`n" -ForegroundColor Green
openrappter onboard
