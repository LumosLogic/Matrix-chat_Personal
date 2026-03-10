#!/bin/bash

echo "🚀 Starting Ngrok Tunnels..."

# Kill existing ngrok processes
pkill -f ngrok 2>/dev/null
sleep 3

# Start ngrok for Matrix (port 8008)
ngrok http 8008 --log=stdout > /tmp/ngrok-matrix.log 2>&1 &
MATRIX_PID=$!

# Start ngrok for API (port 3000)
ngrok http 3000 --log=stdout > /tmp/ngrok-api.log 2>&1 &
API_PID=$!

# Start ngrok for Admin (port 8080)
ngrok http 8080 --log=stdout > /tmp/ngrok-admin.log 2>&1 &
ADMIN_PID=$!

echo "Waiting for tunnels to start..."
sleep 8

# Extract URLs from logs
MATRIX_URL=$(grep -oE "https://[a-z0-9-]+\.ngrok-free\.(app|dev)" /tmp/ngrok-matrix.log | head -1)
API_URL=$(grep -oE "https://[a-z0-9-]+\.ngrok-free\.(app|dev)" /tmp/ngrok-api.log | head -1)
ADMIN_URL=$(grep -oE "https://[a-z0-9-]+\.ngrok-free\.(app|dev)" /tmp/ngrok-admin.log | head -1)

echo ""
echo "✅ Ngrok Tunnels Started!"
echo "================================"
echo "Matrix Homeserver: $MATRIX_URL"
echo "Backend API:       $API_URL"
echo "Admin Panel:       $ADMIN_URL"
echo "================================"
echo ""
echo "PIDs: Matrix=$MATRIX_PID, API=$API_PID, Admin=$ADMIN_PID"
echo "To stop: pkill -f ngrok"