# Start Cloudflare tunnel and auto-update .env with new URL
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

    # Update .env file
    $envPath = "C:\matrix-server\.env"
    $envContent = Get-Content $envPath -Raw
    $envContent = $envContent -replace "BASE_URL=https?://[^\s]+", "BASE_URL=$tunnelUrl"
    Set-Content -Path $envPath -Value $envContent.TrimEnd() -NoNewline

    Write-Host ".env updated with new URL" -ForegroundColor Green
    Write-Host ""
    Write-Host "Restarting all services..." -ForegroundColor Cyan
    pm2 delete all 2>$null
    pm2 start C:\matrix-server\ecosystem.config.js

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "DONE!" -ForegroundColor Green
    Write-Host "Invite links will use: $tunnelUrl" -ForegroundColor Green
    Write-Host "All services running: matrix-server, invite-bot, ai-bot" -ForegroundColor Green
    Write-Host "Tunnel running in background" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
} else {
    Write-Host "Could not find tunnel URL after ${maxWait}s" -ForegroundColor Red
    Write-Host "Check tunnel.log for errors" -ForegroundColor Red
}
