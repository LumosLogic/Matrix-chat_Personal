#!/bin/bash

# Matrix Enterprise Backend - Example curl requests
# Make sure to set your actual ADMIN_API_KEY value

API_URL="http://localhost:3000"
ADMIN_API_KEY="your_secure_admin_api_key_here"

# ============================================
# 1. Health Check
# ============================================
echo "=== Health Check ==="
curl -s -X GET "${API_URL}/health" | jq .
echo ""

# ============================================
# 2. Create an Invite (ADMIN ONLY)
# ============================================
echo "=== Create Invite ==="
curl -s -X POST "${API_URL}/invites" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${ADMIN_API_KEY}" \
  -d '{
    "email": "newuser@example.com"
  }' | jq .
echo ""

# Example response:
# {
#   "success": true,
#   "invite": {
#     "id": "550e8400-e29b-41d4-a716-446655440000",
#     "email": "newuser@example.com",
#     "expires_at": "2024-01-16T12:00:00.000Z",
#     "created_at": "2024-01-15T12:00:00.000Z",
#     "invite_link": "http://localhost:3000/register?token=abc123..."
#   }
# }

# ============================================
# 3. Register a User with Invite Token
# ============================================
echo "=== Register User ==="
# Replace TOKEN_FROM_INVITE with the actual token from step 2
curl -s -X POST "${API_URL}/register" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "TOKEN_FROM_INVITE",
    "username": "johndoe",
    "password": "securepassword123",
    "full_name": "John Doe"
  }' | jq .
echo ""

# Example response:
# {
#   "success": true,
#   "user": {
#     "id": "550e8400-e29b-41d4-a716-446655440001",
#     "email": "newuser@example.com",
#     "full_name": "John Doe",
#     "role": "user",
#     "matrix_user_id": "@johndoe:localhost",
#     "status": "active",
#     "created_at": "2024-01-15T12:05:00.000Z"
#   }
# }

# ============================================
# 4. Get Invite Status (ADMIN ONLY)
# ============================================
echo "=== Get Invite Status ==="
# Replace INVITE_ID with the actual invite ID
curl -s -X GET "${API_URL}/invites/INVITE_ID" \
  -H "X-API-Key: ${ADMIN_API_KEY}" | jq .
echo ""

# ============================================
# ERROR CASES
# ============================================

# Missing API key (401 Unauthorized)
echo "=== Error: Missing API Key ==="
curl -s -X POST "${API_URL}/invites" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}' | jq .
echo ""

# Invalid token (400 Bad Request)
echo "=== Error: Invalid Token ==="
curl -s -X POST "${API_URL}/register" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "invalid_token",
    "username": "testuser",
    "password": "password123",
    "full_name": "Test User"
  }' | jq .
echo ""

# Missing required fields (400 Bad Request)
echo "=== Error: Missing Fields ==="
curl -s -X POST "${API_URL}/register" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "some_token"
  }' | jq .
echo ""

# Invalid username format (400 Bad Request)
echo "=== Error: Invalid Username ==="
curl -s -X POST "${API_URL}/register" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "TOKEN_FROM_INVITE",
    "username": "John Doe",
    "password": "password123",
    "full_name": "John Doe"
  }' | jq .
echo ""
