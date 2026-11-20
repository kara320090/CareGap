$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.12 -m venv .venv
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 and retry setup.' }
    & python -m venv .venv
} else {
    throw 'Python 3.12 is required. Install Python, then run setup again.'
}
if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed.' }
& ./.venv/Scripts/python.exe -m pip install -r requirements.lock
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& ./.venv/Scripts/python.exe -m pip install -e . --no-deps
if ($LASTEXITCODE -ne 0) { throw 'CareGap installation failed.' }
Write-Host 'Setup complete. Run the launcher in the project folder.'
