# Start services with auto-detected laptop IP (no tunnel)
Write-Host "Detecting laptop IP address..." -ForegroundColor Cyan

# Get the primary network adapter IP (exclude loopback and virtual adapters)
$laptopIP = Get-NetIPAddress -AddressFamily IPv4 | 
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -notlike "192.168.32.*" } | 
    Select-Object -First 1 -ExpandProperty IPAddress

if (-not $laptopIP) {
    Write-Host "Could not detect laptop IP, using localhost" -ForegroundColor Yellow
    $laptopIP = "localhost"
}

Write-Host "Detected laptop IP: $laptopIP" -ForegroundColor Green

# Update .env file with local IP
$envPath = "C:\matrix-server\.env"
$envContent = Get-Content $envPath -Raw
$envContent = $envContent -replace "BASE_URL=https?://[^\s]+", "BASE_URL=http://${laptopIP}:3000"
Set-Content -Path $envPath -Value $envContent.TrimEnd() -NoNewline

# Update call-config.json with current IP
$callConfigPath = "C:\matrix-server\public\call-config.json"
$callConfig = @{
    baseUrl = "http://${laptopIP}:3000"
    websocketUrl = "http://${laptopIP}:3000"
    homeserverUrl = "http://${laptopIP}:8008"
} | ConvertTo-Json -Depth 3

Set-Content -Path $callConfigPath -Value $callConfig
Write-Host "Updated configurations with IP: $laptopIP" -ForegroundColor Green

Write-Host ""
Write-Host "Restarting all services..." -ForegroundColor Cyan
pm2 delete all 2>$null
pm2 start C:\matrix-server\ecosystem.config.js

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "DONE!" -ForegroundColor Green
Write-Host "Server URL: http://${laptopIP}:3000" -ForegroundColor Green
Write-Host "Homeserver: http://${laptopIP}:8008" -ForegroundColor Green
Write-Host "Call backend: http://${laptopIP}:3000" -ForegroundColor Green
Write-Host "All services running: matrix-server, invite-bot, ai-bot" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "FluffyChat Integration:" -ForegroundColor Cyan
Write-Host "- Homeserver URL: http://${laptopIP}:8008" -ForegroundColor White
Write-Host "- Call backend will auto-detect from homeserver URL" -ForegroundColor White