#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
LOG_FILE="$SCRIPT_DIR/tunnel.log"

echo -e "${CYAN}Starting Cloudflare tunnel...${NC}"

# Kill any existing cloudflared processes
echo -e "${YELLOW}Stopping old tunnels...${NC}"
pkill -f cloudflared 2>/dev/null
sleep 2

# Remove old log
rm -f "$LOG_FILE"

# Start cloudflared in background, output goes to log file
cloudflared tunnel --url http://localhost:3000 > "$LOG_FILE" 2>&1 &

echo -e "${YELLOW}Waiting for tunnel URL...${NC}"

# Wait up to 30 seconds for the URL to appear in log
MAX_WAIT=30
FOUND=false
TUNNEL_URL=""

for i in $(seq 1 $MAX_WAIT); do
    sleep 1
    if [ -f "$LOG_FILE" ]; then
        TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG_FILE" | head -1)
        if [ -n "$TUNNEL_URL" ]; then
            FOUND=true
            break
        fi
    fi
    echo -n "."
done
echo ""

if [ "$FOUND" = true ]; then
    echo -e "${GREEN}Tunnel URL: $TUNNEL_URL${NC}"

    # Update BASE_URL in .env with the new tunnel URL
    sed -i '' "s|^BASE_URL=.*|BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
    echo -e "${GREEN}.env updated: BASE_URL=$TUNNEL_URL${NC}"

    FINAL_URL="$TUNNEL_URL"
else
    echo -e "${RED}Could not get tunnel URL after ${MAX_WAIT}s. Check tunnel.log for errors.${NC}"
    echo -e "${YELLOW}Falling back to local IP...${NC}"

    # Get local IP (try en0 first, then en1 for WiFi/Ethernet on Mac)
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
    FINAL_URL="http://${LOCAL_IP}:3000"

    sed -i '' "s|^BASE_URL=.*|BASE_URL=$FINAL_URL|" "$ENV_FILE"
    echo -e "${YELLOW}.env updated: BASE_URL=$FINAL_URL${NC}"
fi

echo ""
echo -e "${CYAN}Restarting all services...${NC}"
pm2 delete all 2>/dev/null
sleep 1
pm2 start "$SCRIPT_DIR/ecosystem.config.js"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${GREEN}DONE!${NC}"
echo -e "${GREEN}Server URL : $FINAL_URL${NC}"
echo -e "${GREEN}Invite links will use: $FINAL_URL/register?token=...${NC}"
echo -e "${CYAN}========================================${NC}"
