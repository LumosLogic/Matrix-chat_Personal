#!/bin/bash
# Locate cloudflared (handles both Intel and Apple Silicon brew paths)
if command -v cloudflared &>/dev/null; then
    CLOUDFLARED=$(command -v cloudflared)
elif [ -f /opt/homebrew/bin/cloudflared ]; then
    CLOUDFLARED=/opt/homebrew/bin/cloudflared
elif [ -f /usr/local/bin/cloudflared ]; then
    CLOUDFLARED=/usr/local/bin/cloudflared
elif [ -f /usr/local/opt/cloudflared/bin/cloudflared ]; then
    CLOUDFLARED=/usr/local/opt/cloudflared/bin/cloudflared
else
    echo "[ERROR] cloudflared not found. Install with: brew install cloudflared"
    exit 1
fi

exec "$CLOUDFLARED" tunnel --url http://localhost:3000
