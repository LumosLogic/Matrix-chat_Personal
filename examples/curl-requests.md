# Matrix Enterprise Backend - Example curl Requests

## Setup

Before testing, ensure:
1. The server is running: `npm start`
2. Your `.env` file has the correct `ADMIN_API_KEY`
3. Matrix Synapse is running on `http://localhost:8008`
4. PostgreSQL is running with the `enterprise_db` database

---

## 1. Health Check

```bash
curl -X GET http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "database": "connected"
}
```

---

## 2. Create an Invite (Admin Only)

```bash
curl -X POST http://localhost:3000/invites ^
  -H "Content-Type: application/json" ^
  -H "X-API-Key: your_secure_admin_api_key_here" ^
  -d "{\"email\": \"newuser@example.com\"}"
```

**Expected Response:**
```json
{
  "success": true,
  "invite": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "newuser@example.com",
    "expires_at": "2024-01-16T12:00:00.000Z",
    "created_at": "2024-01-15T12:00:00.000Z",
    "invite_link": "http://localhost:3000/register?token=a1b2c3d4e5f6..."
  }
}
```

**Copy the token from `invite_link` for the next step.**

---

## 3. Register a User

Replace `TOKEN_FROM_INVITE` with the actual token from step 2.

```bash
curl -X POST http://localhost:3000/register ^
  -H "Content-Type: application/json" ^
  -d "{\"token\": \"TOKEN_FROM_INVITE\", \"username\": \"johndoe\", \"password\": \"securepassword123\", \"full_name\": \"John Doe\"}"
```

**Expected Response:**
```json
{
  "success": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "email": "newuser@example.com",
    "full_name": "John Doe",
    "role": "user",
    "matrix_user_id": "@johndoe:localhost",
    "status": "active",
    "created_at": "2024-01-15T12:05:00.000Z"
  }
}
```

---

## 4. Get Invite Status (Admin Only)

Replace `INVITE_ID` with the actual invite UUID.

```bash
curl -X GET http://localhost:3000/invites/INVITE_ID ^
  -H "X-API-Key: your_secure_admin_api_key_here"
```

---

## Error Cases

### Missing API Key (401)
```bash
curl -X POST http://localhost:3000/invites ^
  -H "Content-Type: application/json" ^
  -d "{\"email\": \"test@example.com\"}"
```

### Invalid/Expired Token (400)
```bash
curl -X POST http://localhost:3000/register ^
  -H "Content-Type: application/json" ^
  -d "{\"token\": \"invalid_token\", \"username\": \"testuser\", \"password\": \"password123\", \"full_name\": \"Test User\"}"
```

### Missing Required Fields (400)
```bash
curl -X POST http://localhost:3000/register ^
  -H "Content-Type: application/json" ^
  -d "{\"token\": \"some_token\"}"
```

### Invalid Username Format (400)
```bash
curl -X POST http://localhost:3000/register ^
  -H "Content-Type: application/json" ^
  -d "{\"token\": \"TOKEN\", \"username\": \"John Doe\", \"password\": \"password123\", \"full_name\": \"John Doe\"}"
```

---

## PowerShell Examples

If using PowerShell, use `Invoke-RestMethod`:

### Create Invite
```powershell
$headers = @{
    "Content-Type" = "application/json"
    "X-API-Key" = "your_secure_admin_api_key_here"
}
$body = @{ email = "newuser@example.com" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/invites" -Method POST -Headers $headers -Body $body
```

### Register User
```powershell
$headers = @{ "Content-Type" = "application/json" }
$body = @{
    token = "TOKEN_FROM_INVITE"
    username = "johndoe"
    password = "securepassword123"
    full_name = "John Doe"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/register" -Method POST -Headers $headers -Body $body
```
