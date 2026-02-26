# OAuth 2.0 Client Credentials - Integration Guide

> **Note:** This guide covers the OAuth 2.0 Client Credentials flow (machine-to-machine API access).
> For user login with Authorization Code Flow, see [OAuth Authorization Code Flow](oauth-authorization-code.md).

This guide explains how to use OAuth 2.0 Client Credentials to access iHub Apps APIs programmatically from external applications.

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Obtaining Credentials](#obtaining-credentials)
4. [Generating Tokens](#generating-tokens)
5. [Using Tokens](#using-tokens)
6. [Token Management](#token-management)
7. [Security Best Practices](#security-best-practices)
8. [Incident Response](#incident-response)
9. [Troubleshooting](#troubleshooting)

## Overview

OAuth 2.0 Client Credentials is a grant type designed for machine-to-machine authentication. It allows your applications to authenticate with iHub Apps without user interaction.

### Key Features

- **No User Interaction**: Automated, server-to-server authentication
- **Secure**: Industry-standard OAuth 2.0 protocol
- **Granular Permissions**: Control access to specific apps and models
- **Credential Rotation**: Zero-downtime secret rotation
- **Audit Trail**: Complete logging of all OAuth operations

## Getting Started

### Prerequisites

- Admin access to iHub Apps
- OAuth must be enabled in platform configuration
- A client application that needs API access

### Enable OAuth

Add to `contents/config/platform.json`:

```json
{
  "oauth": {
    "enabled": true,
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440
  }
}
```

Restart the server for changes to take effect.

## Obtaining Credentials

### Step 1: Create OAuth Client

Use the admin API to create a new OAuth client:

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Integration",
    "description": "External system integration",
    "scopes": ["chat", "models"],
    "allowedApps": ["chat", "summarizer"],
    "allowedModels": ["gpt-4", "claude-3"],
    "tokenExpirationMinutes": 60
  }'
```

**Response:**

```json
{
  "success": true,
  "message": "OAuth client created successfully. Save the client_secret - it will not be shown again.",
  "client": {
    "clientId": "client_abc123...",
    "clientSecret": "d4f5e6a7b8c9...",
    "name": "My Integration",
    "scopes": ["chat", "models"],
    "tokenExpirationMinutes": 60
  }
}
```

⚠️ **Important**: Save the `clientSecret` immediately. It will never be shown again!

### Step 2: Configure Your Application

Store the credentials securely in your application:

```bash
# Environment variables (recommended)
export IHUB_CLIENT_ID="client_abc123..."
export IHUB_CLIENT_SECRET="d4f5e6a7b8c9..."
export IHUB_API_URL="https://your-ihub-instance.com"
```

## Generating Tokens

### OAuth Flow

#### 1. Request Access Token

```bash
curl -X POST https://your-ihub-instance.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "client_abc123...",
    "client_secret": "d4f5e6a7b8c9...",
    "scope": "chat models"
  }'
```

**Response:**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "chat models"
}
```

#### 2. Code Examples

##### Node.js

```javascript
const axios = require('axios');

async function getAccessToken() {
  try {
    const response = await axios.post(
      'https://your-ihub-instance.com/api/oauth/token',
      {
        grant_type: 'client_credentials',
        client_id: process.env.IHUB_CLIENT_ID,
        client_secret: process.env.IHUB_CLIENT_SECRET,
        scope: 'chat models'
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('Token generation failed:', error.response?.data);
    throw error;
  }
}

// Use the token
async function callAPI() {
  const token = await getAccessToken();
  
  const response = await axios.post(
    'https://your-ihub-instance.com/api/chat/completions',
    {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data;
}
```

##### Python

```python
import requests
import os

def get_access_token():
    url = f"{os.environ['IHUB_API_URL']}/api/oauth/token"
    
    response = requests.post(url, json={
        'grant_type': 'client_credentials',
        'client_id': os.environ['IHUB_CLIENT_ID'],
        'client_secret': os.environ['IHUB_CLIENT_SECRET'],
        'scope': 'chat models'
    })
    
    response.raise_for_status()
    return response.json()['access_token']

def call_api():
    token = get_access_token()
    
    url = f"{os.environ['IHUB_API_URL']}/api/chat/completions"
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }
    
    response = requests.post(url, json={
        'model': 'gpt-4',
        'messages': [{'role': 'user', 'content': 'Hello'}]
    }, headers=headers)
    
    response.raise_for_status()
    return response.json()
```

## Using Tokens

### API Request Format

All API requests must include the token in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Token Expiration

Tokens expire after the configured duration (default: 60 minutes). Your application should:

1. Check token expiration before use
2. Request a new token when expired
3. Implement token caching to reduce requests

### Example: Token Caching

```javascript
class TokenManager {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.expiresAt = null;
  }
  
  async getToken() {
    // Check if token is still valid
    if (this.token && this.expiresAt > Date.now()) {
      return this.token;
    }
    
    // Request new token
    const response = await axios.post(
      'https://your-ihub-instance.com/api/oauth/token',
      {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      }
    );
    
    this.token = response.data.access_token;
    this.expiresAt = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 min buffer
    
    return this.token;
  }
}
```

## Testing OAuth with curl

This section provides step-by-step examples for testing OAuth authentication using curl commands.

### Complete Workflow Example

#### Step 1: Generate Access Token

```bash
# Set environment variables for convenience
export IHUB_API_URL="http://localhost:3000"  # or https://your-ihub-instance.com
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_client_secret"

# Request access token
curl -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq .
```

**Expected Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "chat models"
}
```

#### Step 2: Extract and Save Token

```bash
# Save token to environment variable
export ACCESS_TOKEN=$(curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq -r '.access_token')

# Verify token was saved
echo "Token: ${ACCESS_TOKEN:0:50}..."
```

#### Step 3: Test OpenAI-Compatible Endpoint

Test the `/api/inference/v1/chat/completions` endpoint (OpenAI-compatible):

```bash
curl -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "Hello, this is a test!"
      }
    ],
    "temperature": 0.7,
    "max_tokens": 100
  }' | jq .
```

#### Step 4: Test App-Specific Chat Endpoint

Test the app-specific chat endpoint:

```bash
curl -X POST "$IHUB_API_URL/api/apps/chat/chat" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, this is a test!",
    "modelId": "gpt-4",
    "variables": {}
  }' | jq .
```

#### Step 5: List Available Models

```bash
curl -X GET "$IHUB_API_URL/api/inference/v1/models" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

**Expected Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "model",
      "id": "gpt-4"
    },
    {
      "object": "model",
      "id": "claude-3"
    }
  ]
}
```

### Testing with Static API Keys (Long-Term Tokens)

If you've generated a static API key, you can use it directly without the OAuth flow:

```bash
# Set your static API key
export STATIC_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Test inference endpoint with static key
curl -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $STATIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "Hello with static key!"
      }
    ]
  }' | jq .
```

### Introspecting Tokens

Check if your token is valid and view its metadata:

```bash
curl -X POST "$IHUB_API_URL/api/oauth/introspect" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$ACCESS_TOKEN\"
  }" | jq .
```

**Expected Response:**
```json
{
  "active": true,
  "client_id": "client_abc123",
  "scopes": ["chat", "models"],
  "exp": 1705664400,
  "iat": 1705660800
}
```

### Common Testing Scenarios

#### Test Invalid Credentials
```bash
# Should return 401 Unauthorized
curl -v -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "invalid_client",
    "client_secret": "invalid_secret"
  }'
```

#### Test Expired Token
```bash
# Use an expired token - should return 401 Unauthorized
curl -v -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer EXPIRED_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

#### Test Missing Authorization Header
```bash
# Should return 401 Unauthorized
curl -v -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

### Debugging Tips

#### 1. Verbose Output
Add `-v` flag to see full request/response details:
```bash
curl -v -X POST "$IHUB_API_URL/api/oauth/token" ...
```

#### 2. Save Response to File
```bash
curl -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{...}" \
  -o token_response.json
```

#### 3. Decode JWT Token
Use [jwt.io](https://jwt.io) or decode in terminal:
```bash
# macOS/Linux with base64
echo "$ACCESS_TOKEN" | cut -d. -f2 | base64 -d | jq .
```

#### 4. Check Server Logs
Monitor server logs for authentication issues:
```bash
# If running locally
tail -f server/logs/server.log

# Or check stdout/stderr if running in foreground
```

### Complete Test Script

Here's a complete bash script to test OAuth authentication:

```bash
#!/bin/bash

# Configuration
IHUB_API_URL="${IHUB_API_URL:-http://localhost:3000}"
CLIENT_ID="${CLIENT_ID:-your_client_id}"
CLIENT_SECRET="${CLIENT_SECRET:-your_client_secret}"

echo "Testing OAuth Authentication..."
echo "API URL: $IHUB_API_URL"
echo "Client ID: $CLIENT_ID"
echo ""

# Step 1: Get access token
echo "1. Requesting access token..."
TOKEN_RESPONSE=$(curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }")

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "❌ Failed to get access token"
  echo "$TOKEN_RESPONSE" | jq .
  exit 1
fi

echo "✅ Access token obtained: ${ACCESS_TOKEN:0:50}..."
echo ""

# Step 2: Introspect token
echo "2. Introspecting token..."
INTROSPECT_RESPONSE=$(curl -s -X POST "$IHUB_API_URL/api/oauth/introspect" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$ACCESS_TOKEN\"}")

echo "$INTROSPECT_RESPONSE" | jq .
echo ""

# Step 3: List models
echo "3. Listing available models..."
MODELS_RESPONSE=$(curl -s -X GET "$IHUB_API_URL/api/inference/v1/models" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "$MODELS_RESPONSE" | jq .
echo ""

# Step 4: Test chat completion
echo "4. Testing chat completion..."
CHAT_RESPONSE=$(curl -s -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "Say hello in one word"
      }
    ],
    "max_tokens": 10
  }')

echo "$CHAT_RESPONSE" | jq .
echo ""

echo "✅ OAuth authentication test completed!"
```

Save this script as `test-oauth.sh`, make it executable with `chmod +x test-oauth.sh`, and run it:

```bash
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_secret"
export IHUB_API_URL="http://localhost:3000"
./test-oauth.sh
```

## Token Management

### Static API Keys

For applications that don't support OAuth flow, you can generate long-lived static API keys:

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123/generate-token \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "expirationDays": 365
  }'
```

**Response:**

```json
{
  "success": true,
  "message": "Static API key generated successfully. Save this key - it will not be shown again.",
  "api_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 31536000,
  "expires_at": "2027-01-19T10:00:00.000Z",
  "scope": "chat models"
}
```

Use the static key exactly like a regular token:

```bash
curl -X POST https://your-ihub-instance.com/api/chat/completions \
  -H "Authorization: Bearer STATIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

### Token Introspection

Check if a token is valid:

```bash
curl -X POST https://your-ihub-instance.com/api/oauth/introspect \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'
```

**Response:**

```json
{
  "active": true,
  "client_id": "client_abc123",
  "scopes": ["chat", "models"],
  "exp": 1705664400,
  "iat": 1705660800
}
```

## Security Best Practices

### 1. Protect Client Secrets

- **Never commit secrets to version control**
- Store secrets in environment variables or secret managers
- Use different credentials for development and production
- Rotate secrets regularly

### 2. Use HTTPS

Always use HTTPS in production to protect credentials in transit:

```javascript
// ❌ Never do this in production
const apiUrl = 'http://your-ihub-instance.com';

// ✅ Always use HTTPS
const apiUrl = 'https://your-ihub-instance.com';
```

### 3. Implement Token Caching

Don't request a new token for every API call. Cache tokens and reuse them until expiration.

### 4. Handle Errors Gracefully

```javascript
async function callAPIWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const token = await getAccessToken();
      return await callAPI(token);
    } catch (error) {
      if (error.response?.status === 401 && i < maxRetries - 1) {
        // Token expired or invalid, retry
        continue;
      }
      throw error;
    }
  }
}
```

### 5. Limit Permissions

Only grant the minimum scopes and access needed:

```json
{
  "scopes": ["chat"],
  "allowedApps": ["summarizer"],
  "allowedModels": ["gpt-4"]
}
```

## Incident Response

### If a Secret is Compromised

#### 1. Immediate Action - Suspend the Client

```bash
curl -X PUT https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123 \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false
  }'
```

This immediately invalidates all tokens issued to this client.

#### 2. Investigate

Check audit logs for unauthorized access:

```bash
# SSH into server
grep "client_id=client_abc123" /var/log/ihub-apps/oauth-audit.log
```

#### 3. Rotate Secret

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123/rotate-secret \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Response:**

```json
{
  "success": true,
  "message": "Client secret rotated successfully. Save the new secret - it will not be shown again.",
  "clientId": "client_abc123",
  "clientSecret": "new_secret_xyz...",
  "rotatedAt": "2026-01-19T12:00:00.000Z"
}
```

#### 4. Update Application

Update your application with the new secret:

```bash
export IHUB_CLIENT_SECRET="new_secret_xyz..."
```

#### 5. Re-enable Client

```bash
curl -X PUT https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123 \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "active": true
  }'
```

## Troubleshooting

### Error: invalid_client

**Cause**: Wrong client ID or secret

**Solution**:
- Verify credentials are correct
- Check for typos or whitespace
- Ensure client is active

### Error: invalid_grant

**Cause**: Wrong grant_type

**Solution**: Use `"grant_type": "client_credentials"`

### Error: invalid_scope

**Cause**: Requested scope not allowed for this client

**Solution**: Check client configuration and only request allowed scopes

### Error: token_expired

**Cause**: Token has expired

**Solution**: Request a new token

### Error: access_denied

**Cause**: Client is suspended

**Solution**: Contact administrator to reactivate the client

### Error: insufficient_scope

**Cause**: Token lacks required permissions for the operation

**Solution**: Request a token with appropriate scopes or update client permissions

## Additional Resources

- [RFC 6749: OAuth 2.0 Authorization Framework](https://tools.ietf.org/html/rfc6749)
- [OAuth 2.0 Security Best Current Practice](https://tools.ietf.org/html/draft-ietf-oauth-security-topics)
- iHub Apps API Documentation: `/api/docs` (Swagger UI)

## Support

For questions or issues:

1. Check server logs: `tail -f logs/oauth-audit.log`
2. Review this guide
3. Contact your iHub Apps administrator
