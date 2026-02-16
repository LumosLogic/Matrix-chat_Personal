# Start services with auto-detected laptop IP and optional Cloudflare tunnel
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

# Update call-config.json with current IP
$callConfigPath = "C:\matrix-server\public\call-config.json"
$callConfig = @{
    baseUrl = "http://${laptopIP}:3000"
    websocketUrl = "http://${laptopIP}:3000"
    homeserverUrl = "http://${laptopIP}:8008"
} | ConvertTo-Json -Depth 3

Set-Content -Path $callConfigPath -Value $callConfig
Write-Host "Updated call-config.json with IP: $laptopIP" -ForegroundColor Green

# Ask user if they want to use tunnel or local IP
Write-Host ""
Write-Host "Choose connection mode:" -ForegroundColor Cyan
Write-Host "1. Local IP only (http://${laptopIP}:3000)" -ForegroundColor White
Write-Host "2. Cloudflare tunnel (public access)" -ForegroundColor White
$choice = Read-Host "Enter choice (1 or 2, default: 1)"

if ($choice -eq "2") {
    Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
    
    # Kill any existing cloudflared processes
    Write-Host "Stopping old tunnels..." -ForegroundColor Yellow
    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    
    # Start cloudflared in background and log to file
    $logFile = "C:\matrix-server\tunnel.log"
    Remove-Item $logFile -ErrorAction SilentlyContinue
    
    Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "--url", "http://localhost:3000" -RedirectStandardError $logFile -WindowStyle Hidden
    
    # Wait for URL to appear in log
    Write-Host "Waiting for tunnel URL..." -ForegroundColor Yellow
    $maxWait = 30
    $found = $false
    
    for ($i = 0; $i -lt $maxWait; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $logFile) {
            $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
            if ($content -match "(https://[a-z0-9-]+\.trycloudflare\.com)") {
                $tunnelUrl = $matches[1]
                $found = $true
                break
            }
        }
        Write-Host "." -NoNewline
    }
    Write-Host ""
    
    if ($found) {
        Write-Host "Tunnel URL: $tunnelUrl" -ForegroundColor Green
        
        # Update .env file with tunnel URL
        $envPath = "C:\matrix-server\.env"
        $envContent = Get-Content $envPath -Raw
        $envContent = $envContent -replace "BASE_URL=https?://[^\s]+", "BASE_URL=$tunnelUrl"
        Set-Content -Path $envPath -Value $envContent.TrimEnd() -NoNewline
        
        # Update call-config.json with tunnel URL
        $callConfig = @{
            baseUrl = $tunnelUrl
            websocketUrl = $tunnelUrl
            homeserverUrl = $tunnelUrl
        } | ConvertTo-Json -Depth 3
        Set-Content -Path $callConfigPath -Value $callConfig
        
        Write-Host ".env and call-config.json updated with tunnel URL" -ForegroundColor Green
        $finalUrl = $tunnelUrl
    } else {
        Write-Host "Could not get tunnel URL, falling back to local IP" -ForegroundColor Yellow
        $finalUrl = "http://${laptopIP}:3000"
    }
} else {
    Write-Host "Using local IP mode" -ForegroundColor Green
    
    # Update .env file with local IP
    $envPath = "C:\matrix-server\.env"
    $envContent = Get-Content $envPath -Raw
    $envContent = $envContent -replace "BASE_URL=https?://[^\s]+", "BASE_URL=http://${laptopIP}:3000"
    Set-Content -Path $envPath -Value $envContent.TrimEnd() -NoNewline
    
    Write-Host ".env updated with local IP" -ForegroundColor Green
    $finalUrl = "http://${laptopIP}:3000"
}

Write-Host ""
Write-Host "Restarting all services..." -ForegroundColor Cyan
pm2 delete all 2>$null
pm2 start C:\matrix-server\ecosystem.config.js

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "DONE!" -ForegroundColor Green
Write-Host "Server URL: $finalUrl" -ForegroundColor Green
Write-Host "Homeserver: http://${laptopIP}:8008" -ForegroundColor Green
Write-Host "Call backend: $finalUrl" -ForegroundColor Green
Write-Host "All services running: matrix-server, invite-bot, ai-bot" -ForegroundColor Green
if ($choice -eq "2" -and $found) {
    Write-Host "Tunnel running in background" -ForegroundColor Yellow
}
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "FluffyChat Integration:" -ForegroundColor Cyan
Write-Host "- Homeserver URL: http://${laptopIP}:8008" -ForegroundColor White
Write-Host "- Call backend will auto-detect from homeserver URL" -ForegroundColor White
