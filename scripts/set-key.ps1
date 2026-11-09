# Saves a secret into this project's .env without showing it on screen.
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\set-key.ps1 ANTHROPIC_API_KEY
param([Parameter(Mandatory = $true)][string]$Name)

$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envPath)) { Write-Host "Can't find $envPath" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Paste the value for $Name and press Enter." -ForegroundColor Cyan
Write-Host "(Nothing will show while you paste. That's normal. Right-click pastes in this window.)"
$secure = Read-Host -AsSecureString "$Name"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim().Trim('"').Trim("'") }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if (-not $value) { Write-Host "Nothing was pasted. Run it again." -ForegroundColor Yellow; exit 1 }

$lines = [IO.File]::ReadAllLines($envPath)
$found = $false
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match "^\s*$Name\s*=") { $lines[$i] = "$Name=$value"; $found = $true; break }
}
if (-not $found) { $lines += "$Name=$value" }
[IO.File]::WriteAllLines($envPath, $lines, (New-Object Text.UTF8Encoding($false)))

$preview = $value.Substring(0, [Math]::Min(3, $value.Length))
Write-Host ""
Write-Host "Saved $Name ($($value.Length) characters, starts with $preview...)." -ForegroundColor Green
Write-Host "You can close this tab and tell Claude it's done."
