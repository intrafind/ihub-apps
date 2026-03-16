# API Curl Examples for Office Integrations

A copy-paste cookbook for authenticating, listing apps, and chatting with iHub Apps from the command line or a backend service.

For full reference documentation, see:

- [OAuth Client Credentials (machine-to-machine)](oauth-integration-guide.md)
- [OAuth Authorization Code Flow (user login)](oauth-authorization-code.md)

## Prerequisites

Set up these variables for all examples below:

```bash
# Your iHub Apps base URL (no trailing slash)
export BASE_URL="https://your-ihub-instance.com"

# Tools: curl, jq (optional but recommended), uuidgen
```

All authenticated requests use the `Authorization: Bearer <token>` header.

---

## 1. Authentication

### 1a. Check Available Auth Methods

Discover which authentication methods are enabled on the server:

```bash
curl -s "$BASE_URL/api/auth/status" | jq .
```

Example response (trimmed):

```json
{
  "authMethods": {
    "local": true,
    "oidc": true,
    "oauth": true
  },
  "oidcProviders": [
    {
      "name": "azure-ad",
      "displayName": "Azure AD",
      "authURL": "/api/auth/oidc/azure-ad"
    }
  ]
}
```

### 1b. OAuth Client Credentials (Recommended for Server-to-Server)

This is the simplest flow for backend integrations with no user interaction. An admin must first create an OAuth client — see [Obtaining Credentials](oauth-integration-guide.md#obtaining-credentials).

```bash
# Set your client credentials
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_client_secret"

# Request an access token
curl -s -X POST "$BASE_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\",
    \"scope\": \"chat models\"
  }" | jq .
```

Response:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "chat models"
}
```

**One-liner to extract and save the token:**

```bash
export TOKEN=$(curl -s -X POST "$BASE_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq -r '.access_token')

echo "Token: ${TOKEN:0:50}..."
```

### 1c. OAuth Authorization Code + PKCE (User-Delegated Access)

Use this when your integration acts on behalf of a logged-in user. Full details: [OAuth Authorization Code Flow](oauth-authorization-code.md).

**Step 1 — Generate PKCE parameters and build the authorize URL:**

```bash
# Generate PKCE code_verifier (43+ chars, URL-safe random)
export CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')

# Compute code_challenge = base64url(SHA256(code_verifier))
export CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" \
  | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_')

# Random state for CSRF protection
export STATE=$(openssl rand -hex 16)

export CLIENT_ID="your_client_id"
export REDIRECT_URI="https://your-app.example.com/auth/callback"

echo "Open this URL in a browser:"
echo "$BASE_URL/api/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid+profile+email&state=$STATE&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"
```

**Step 2 — User authenticates in the browser.** After approval, the browser redirects to:

```
https://your-app.example.com/auth/callback?code=AUTH_CODE&state=STATE
```

**Step 3 — Exchange the authorization code for tokens:**

```bash
export AUTH_CODE="the_code_from_callback"

curl -s -X POST "$BASE_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"authorization_code\",
    \"code\": \"$AUTH_CODE\",
    \"redirect_uri\": \"$REDIRECT_URI\",
    \"client_id\": \"$CLIENT_ID\",
    \"code_verifier\": \"$CODE_VERIFIER\"
  }" | jq .
```

Response:

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid profile email"
}
```

Save the token:

```bash
export TOKEN="eyJhbGciOiJSUzI1NiIs..."
```

### 1d. OIDC Login (Browser-Based Alternative)

If your server uses OIDC with an external identity provider (e.g., Azure AD, Keycloak):

1. Open `$BASE_URL/api/auth/oidc/<provider>` in a browser (e.g., `/api/auth/oidc/azure-ad`)
2. Authenticate with the identity provider
3. After redirect, extract the token from the URL query parameter `?token=...`

```bash
export TOKEN="the_token_from_url"
```

> **Note:** OIDC login requires browser interaction. For automated integrations, prefer OAuth Client Credentials (section 1b).

### 1e. Token Introspection

Verify a token is still valid and view its metadata:

```bash
curl -s -X POST "$BASE_URL/api/oauth/introspect" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$TOKEN\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq .
```

Response:

```json
{
  "active": true,
  "client_id": "client_abc123",
  "scopes": ["chat", "models"],
  "exp": 1709990400,
  "iat": 1709986800
}
```

### 1f. Token Refresh

If you obtained a refresh token via the Authorization Code flow:

```bash
curl -s -X POST "$BASE_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"refresh_token\",
    \"refresh_token\": \"$REFRESH_TOKEN\",
    \"client_id\": \"$CLIENT_ID\"
  }" | jq .
```

---

## 2. Listing Apps and Models

### 2a. Get All Available Apps

```bash
curl -s "$BASE_URL/api/apps" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Example response:

```json
[
  {
    "id": "chat-assistant",
    "name": { "en": "Chat Assistant" },
    "description": { "en": "General-purpose AI assistant" },
    "color": "#4F46E5",
    "icon": "chat",
    "preferredModel": "gpt-4o",
    "tokenLimit": 4000
  },
  {
    "id": "summarizer",
    "name": { "en": "Summarizer" },
    "description": { "en": "Summarize documents and text" },
    "color": "#059669",
    "icon": "document",
    "preferredModel": "gpt-4o",
    "tokenLimit": 8000
  }
]
```

**Tip — list just app IDs:**

```bash
curl -s "$BASE_URL/api/apps" \
  -H "Authorization: Bearer $TOKEN" | jq '.[].id'
```

### 2b. Get Available Models

```bash
curl -s "$BASE_URL/api/models" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 3. Chat with an App (SSE Streaming)

### 3a. How It Works

iHub Apps uses a two-request pattern for streaming chat:

```
Client                                 Server
  |                                      |
  |--- GET /api/apps/{appId}/chat/{chatId} --->   (opens SSE stream)
  |<--- 200 OK, text/event-stream -------|        (keep-alive connection)
  |                                      |
  |--- POST /api/apps/{appId}/chat/{chatId} -->   (send message)
  |<--- 200 OK {"status":"streaming"} ---|
  |                                      |
  |<--- event: session.start ------------|
  |<--- event: chunk -------------------|        (text tokens arrive)
  |<--- event: chunk -------------------|
  |<--- event: done --------------------|        (response complete)
```

1. **GET** opens a persistent SSE connection (must be opened first)
2. **POST** sends the user's message; the LLM response streams back over the SSE connection
3. The `chatId` is a client-generated UUID that links the two requests

### 3b. Generate a Chat ID

```bash
export APP_ID="chat-assistant"
export CHAT_ID=$(uuidgen)
echo "Chat ID: $CHAT_ID"
```

### 3c. Open the SSE Connection

Run this in the background — it stays open and prints events to the terminal:

```bash
curl -N -s "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: text/event-stream" &
SSE_PID=$!
echo "SSE connection opened (PID: $SSE_PID)"
```

> The `-N` flag disables buffering so events appear immediately.

### 3d. Send a Message

```bash
curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "Summarize the key benefits of cloud computing in 3 bullet points."
      }
    ]
  }' | jq .
```

Response (the actual LLM output streams over SSE):

```json
{
  "status": "streaming",
  "chatId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 3e. Understanding SSE Events

Events appear on the SSE connection in this wire format:

```
event: session.start
data: {"event":"session.start","chatId":"550e8400-...","timestamp":"2026-03-16T10:30:00Z"}

event: chunk
data: {"event":"chunk","chatId":"550e8400-...","content":"Cloud computing"}

event: chunk
data: {"event":"chunk","chatId":"550e8400-...","content":" offers several"}

event: chunk
data: {"event":"chunk","chatId":"550e8400-...","content":" key benefits:"}

event: done
data: {"event":"done","chatId":"550e8400-...","finishReason":"stop"}
```

**Event types reference:**

| Event | Description |
|---|---|
| `session.start` | Chat session started |
| `chunk` | Text token from the LLM (concatenate `content` fields for full response) |
| `done` | Response complete; `finishReason` indicates why |
| `error` | An error occurred; check `message` field |
| `thinking` | Extended thinking content (supported models only) |
| `tool.call.start` | Tool execution started |
| `tool.call.end` | Tool execution completed |
| `citation` | Source citation reference |
| `conversation.title` | Auto-generated conversation title |

### 3f. Advanced Options

Specify model, temperature, output format, and other options in the POST body:

```bash
curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "Explain quantum computing."
      }
    ],
    "modelId": "gpt-4o",
    "temperature": 0.3,
    "outputFormat": "markdown"
  }' | jq .
```

**Available POST body fields:**

| Field | Type | Description |
|---|---|---|
| `messages` | array | **Required.** Array of `{role, content}` objects |
| `modelId` | string | Override the app's default model |
| `temperature` | number | Sampling temperature (0–2) |
| `outputFormat` | string | `markdown`, `text`, `json`, or `html` |
| `language` | string | BCP 47 language code (e.g., `de`, `fr`) |
| `enabledTools` | array | Tool names to enable for this request |
| `thinkingEnabled` | boolean | Enable extended thinking |

### 3g. Multi-Turn Conversation

Include prior messages for context in follow-up requests:

```bash
curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "What is cloud computing?"
      },
      {
        "role": "assistant",
        "content": "Cloud computing is the delivery of computing services over the internet..."
      },
      {
        "role": "user",
        "content": "What are the main providers?"
      }
    ]
  }' | jq .
```

### 3h. Stop a Stream

Abort an in-progress response:

```bash
curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID/stop" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Response:

```json
{
  "success": true,
  "message": "Chat stream stopped"
}
```

### 3i. Clean Up the SSE Connection

When you're done chatting, kill the background curl process:

```bash
kill $SSE_PID 2>/dev/null
```

### 3j. Non-Streaming Alternative

If you skip the GET SSE connection and just POST directly, the response is returned inline (non-streaming):

```bash
export CHAT_ID=$(uuidgen)

curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "What is 2 + 2?"
      }
    ]
  }' | jq .
```

> This returns the complete response in one JSON payload instead of streaming chunks.

---

## 4. Complete End-to-End Script

```bash
#!/bin/bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────
BASE_URL="${BASE_URL:-https://your-ihub-instance.com}"
CLIENT_ID="${CLIENT_ID:-your_client_id}"
CLIENT_SECRET="${CLIENT_SECRET:-your_client_secret}"

echo "=== iHub Apps API Example ==="
echo "Server: $BASE_URL"
echo ""

# ─── Step 1: Authenticate ────────────────────────────────────────
echo "1. Authenticating via OAuth Client Credentials..."
TOKEN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "Authentication failed:"
  echo "$TOKEN_RESPONSE" | jq .
  exit 1
fi
echo "   Token obtained: ${TOKEN:0:50}..."
echo ""

# ─── Step 2: List Apps ───────────────────────────────────────────
echo "2. Listing available apps..."
APPS=$(curl -s "$BASE_URL/api/apps" -H "Authorization: Bearer $TOKEN")
echo "$APPS" | jq '.[].id'
echo ""

# Pick the first app
APP_ID=$(echo "$APPS" | jq -r '.[0].id')
APP_NAME=$(echo "$APPS" | jq -r '.[0].name.en // .[0].name | keys[0] as $k | .[$k]')
echo "   Using app: $APP_ID ($APP_NAME)"
echo ""

# ─── Step 3: Chat with SSE Streaming ─────────────────────────────
CHAT_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
echo "3. Starting chat session: $CHAT_ID"
echo ""

# Open SSE connection in background
echo "   Opening SSE connection..."
curl -N -s "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: text/event-stream" &
SSE_PID=$!
sleep 1

# Send a message
echo ""
echo "   Sending message..."
curl -s -X POST "$BASE_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "Say hello and tell me one fun fact. Keep it short."
      }
    ]
  }' | jq .

# Wait for the response to stream
echo ""
echo "   Waiting for response to complete..."
sleep 10

# ─── Step 4: Cleanup ─────────────────────────────────────────────
echo ""
echo "4. Cleaning up..."
kill $SSE_PID 2>/dev/null || true
echo "   Done!"
```

**Usage:**

```bash
export BASE_URL="https://your-ihub-instance.com"
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_secret"
chmod +x test-api.sh
./test-api.sh
```

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Token expired or invalid | Request a new token (section 1b) |
| `403 Forbidden` | OAuth not enabled, or client lacks permissions | Check `platform.json` OAuth config; verify client scopes include the app |
| `404 Not Found` | Wrong app ID or base path | Verify app ID from `/api/apps`; check if server uses a base path prefix (e.g., `/ihub`) |
| SSE connection closes immediately | Auth failure on the GET request | Verify token is valid; check `Authorization` header is present |
| No events after POST | SSE connection not established yet | Ensure the GET request is open before sending the POST |
| `{"error":"invalid_client"}` | Wrong client ID or secret | Double-check credentials; ensure client is active |
| `{"error":"invalid_grant"}` | Wrong grant_type or expired auth code | Use `client_credentials` for server-to-server; auth codes expire in 10 minutes |

**Debug tip:** Add `-v` to any curl command for verbose request/response headers.

---

## Related Documentation

- [OAuth Integration Guide](oauth-integration-guide.md) — Full client credentials reference
- [OAuth Authorization Code Flow](oauth-authorization-code.md) — Full auth code flow reference
- [Authentication Architecture](authentication-architecture.md) — Overview of all auth methods
- [OIDC Authentication](oidc-authentication.md) — External OIDC provider setup
