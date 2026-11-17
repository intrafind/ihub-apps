---
description:
  "Call iHub's APIs from another application with OAuth 2.0 client credentials: setup, tokens,
  static API keys, curl examples for apps, models and streaming chat, and troubleshooting."
audience: developer
type: how-to
adminPage: /admin/oauth/clients
---

# OAuth Client Credentials

> [!NOTE]
> This page covers the OAuth 2.0 Client Credentials flow: machine-to-machine access without a
> signed-in user. For user login from an external app, see
> [OAuth Authorization Code Flow](oauth-authorization-code.md). For a key that acts as one user, see
> [Personal API Keys](personal-api-keys.md).

## Overview

With client credentials, a backend service authenticates to iHub with a client ID and secret and
gets a short-lived bearer token. No user interaction is involved.

- **Scoped access**: each client is limited to the scopes, apps, models and prompts an admin grants.
- **Rotation**: secrets can be rotated, and clients suspended, at any time.
- **Audit**: creating, changing, rotating and generating keys for clients is recorded in
  **Admin → Audit Log**.

## Getting Started

### Prerequisites

- Admin access to iHub
- A client application that needs API access

### Enable OAuth

Two switches in `platform.json` are involved:

| Setting | What it turns on |
| --- | --- |
| `oauth.enabled.clients` | Managing OAuth clients, and accepting the tokens they are issued |
| `oauth.enabled.authz` | The OAuth endpoints, including `POST /api/oauth/token` and `/api/oauth/introspect` |

Client credentials need both. In the admin UI, turn on **OAuth Clients** under **Admin → OAuth →
Clients** and the authorization server under **Admin → OAuth → Server**. Or edit
`contents/config/platform.json`:

```json
{
  "oauth": {
    "enabled": {
      "authz": true,
      "clients": true
    },
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440
  }
}
```

`clientsFile` is optional; it defaults to `config/oauth-clients.json` in the contents directory.
Restart the server after editing the file by hand.

## Obtaining Credentials

### Step 1: Create an OAuth Client

In the admin UI, open **Admin → OAuth → Clients** and click **Create OAuth Client**. Set the name,
the token expiration and the allowed apps, models and prompts. The client ID and secret are shown
once, after saving.

For a client-credentials client the allowed apps, models and prompts **are the grant**: the token
has no user behind it, so the client can use exactly what is listed and nothing of a kind whose list
is empty. A new client therefore starts with nothing selected and cannot be saved without at least
one app. **All (\*)** grants every app, model or prompt, including ones added later, and shows a
warning; prefer listing only what the client needs. For an authorization-code client the same lists
narrow what the signed-in user's groups allow, and an empty list adds no restriction. The editor
warns when you change the grant types of an existing client, because that changes what the lists
mean.

Or use the admin API:

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
    "allowedPrompts": [],
    "tokenExpirationMinutes": 60
  }'
```

| Field | Notes |
| --- | --- |
| `name` | Required |
| `scopes` | Scopes the client may request; default none |
| `allowedApps`, `allowedModels`, `allowedPrompts` | IDs the client may use, stored as sent. Client credentials: an empty or missing list means **none**, `["*"]` means all. Authorization code: an empty list means no restriction on the user's group permissions |
| `allowedGroups` | Authorization Code flow only: groups a signing-in user must belong to; empty means any |
| `tokenExpirationMinutes` | Default `oauth.defaultTokenExpirationMinutes` (60); at most `oauth.maxTokenExpirationMinutes` (1440) |

The answer is `201 Created`, with a `Location` header and the new client:

```json
{
  "clientId": "client_abc123...",
  "clientSecret": "d4f5e6a7b8c9...",
  "name": "My Integration",
  "description": "External system integration",
  "scopes": ["chat", "models"],
  "allowedApps": ["chat", "summarizer"],
  "allowedModels": ["gpt-4", "claude-3"],
  "allowedPrompts": [],
  "allowedGroups": [],
  "tokenExpirationMinutes": 60
}
```

> [!WARNING]
> Save the `clientSecret` immediately. It is never shown again. The answer (and the one of
> `POST /api/admin/oauth/clients/{clientId}/rotate-secret`) is sent with `Cache-Control: no-store`.

### Step 2: Configure Your Application

Store the credentials securely, for example in environment variables:

```bash
export IHUB_CLIENT_ID="client_abc123..."
export IHUB_CLIENT_SECRET="d4f5e6a7b8c9..."
export IHUB_API_URL="https://your-ihub-instance.com"
```

## Generating Tokens

### Request an Access Token

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

`scope` is optional; without it the token gets all of the client's scopes. The endpoint also accepts
a form-encoded body (`application/x-www-form-urlencoded`), and the client ID and secret in an HTTP
Basic `Authorization` header instead of the body.

Response:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "chat models"
}
```

### Code Examples

#### Node.js

```javascript
const axios = require('axios');

async function getAccessToken() {
  const response = await axios.post(`${process.env.IHUB_API_URL}/api/oauth/token`, {
    grant_type: 'client_credentials',
    client_id: process.env.IHUB_CLIENT_ID,
    client_secret: process.env.IHUB_CLIENT_SECRET,
    scope: 'chat models'
  });
  return response.data.access_token;
}

async function callAPI() {
  const token = await getAccessToken();
  const response = await axios.post(
    `${process.env.IHUB_API_URL}/api/inference/v1/chat/completions`,
    { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}
```

#### Python

```python
import os
import requests

def get_access_token():
    response = requests.post(f"{os.environ['IHUB_API_URL']}/api/oauth/token", json={
        'grant_type': 'client_credentials',
        'client_id': os.environ['IHUB_CLIENT_ID'],
        'client_secret': os.environ['IHUB_CLIENT_SECRET'],
        'scope': 'chat models'
    })
    response.raise_for_status()
    return response.json()['access_token']

def call_api():
    token = get_access_token()
    response = requests.post(
        f"{os.environ['IHUB_API_URL']}/api/inference/v1/chat/completions",
        json={'model': 'gpt-4', 'messages': [{'role': 'user', 'content': 'Hello'}]},
        headers={'Authorization': f'Bearer {token}'},
    )
    response.raise_for_status()
    return response.json()
```

## Using Tokens

Send the token in the `Authorization` header of every API request:

```text
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Tokens expire after the client's configured duration (default 60 minutes). Cache the token, reuse
it until shortly before `expires_in` runs out, then request a new one:

```javascript
class TokenManager {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken() {
    if (this.token && this.expiresAt > Date.now()) return this.token;

    const response = await axios.post(`${process.env.IHUB_API_URL}/api/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    this.token = response.data.access_token;
    this.expiresAt = Date.now() + response.data.expires_in * 1000 - 60000; // 1 min buffer
    return this.token;
  }
}
```

## Examples with curl

Copy-paste commands for testing a client and for scripts. They need `curl`, `jq` and `uuidgen`.

### Set Up the Shell

```bash
export IHUB_API_URL="https://your-ihub-instance.com"   # no trailing slash; http://localhost:3000 locally
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_client_secret"
```

If iHub runs under a base path, include it in `IHUB_API_URL` (for example
`https://example.com/ihub`).

### Get and Save a Token

```bash
export ACCESS_TOKEN=$(curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq -r '.access_token')

echo "Token: ${ACCESS_TOKEN:0:50}..."
```

To see the whole answer, drop `| jq -r '.access_token'` and pipe to `jq .` instead.

### Check a Token

Introspection tells whether a token is valid and shows its metadata. The caller authenticates with
its own client ID and secret (or an admin session):

```bash
curl -s -X POST "$IHUB_API_URL/api/oauth/introspect" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$ACCESS_TOKEN\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }" | jq .
```

```json
{
  "active": true,
  "scopes": ["chat", "models"],
  "exp": 1705664400,
  "iat": 1705660800,
  "token_type": "oauth_client_credentials",
  "client_id": "client_abc123",
  "client_name": "My Integration",
  "allowedApps": ["chat", "summarizer"],
  "allowedModels": ["gpt-4", "claude-3"]
}
```

An expired or invalid token answers `{ "active": false }`. To decode a token locally, use
[jwt.io](https://jwt.io) or `echo "$ACCESS_TOKEN" | cut -d. -f2 | base64 -d | jq .`.

### Call the OpenAI-Compatible API

The simplest call is one request and one answer. List the models (and apps, as `app:` models) the
client may use:

```bash
curl -s "$IHUB_API_URL/api/inference/v1/models" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

```json
{
  "object": "list",
  "data": [
    { "object": "model", "id": "gpt-4" },
    { "object": "model", "id": "claude-3" }
  ]
}
```

Send a chat completion:

```bash
curl -s -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{ "role": "user", "content": "Hello, this is a test!" }],
    "max_tokens": 100
  }' | jq .
```

This API is stateless: send the whole conversation each time. See
[OpenAI-compatible API](openai-compatible-api.md).

### List Apps and Models

```bash
curl -s "$IHUB_API_URL/api/apps" -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

```json
{
  "items": [
    {
      "id": "chat-assistant",
      "name": { "en": "Chat Assistant" },
      "description": { "en": "General-purpose AI assistant" },
      "color": "#4F46E5",
      "icon": "chat",
      "preferredModel": "gpt-4o"
    }
  ]
}
```

List only the app IDs, or the models:

```bash
curl -s "$IHUB_API_URL/api/apps" -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.items[].id'
curl -s "$IHUB_API_URL/api/models" -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

### Chat with an App over SSE

Chatting with an app uses two requests that share a chat ID you generate:

1. **GET** `/api/apps/{appId}/chat/{chatId}` opens a Server-Sent Events stream. Open it first.
2. **POST** to the same URL sends the message. The answer streams back over the open GET.

```text
Client                                         Server
  |--- GET  /api/apps/{appId}/chat/{chatId} --->|  opens the SSE stream
  |<-- 200 OK, text/event-stream ---------------|
  |--- POST /api/apps/{appId}/chat/{chatId} --->|  sends the message
  |<-- event: stream/connected -----------------|
  |<-- event: run/started ----------------------|
  |<-- event: step/delta  (text arrives) -------|
  |<-- event: run/ended   (answer complete) ----|
  |<-- 200 OK {"status":"streaming"} -----------|
```

#### Open the Stream

```bash
export APP_ID="chat-assistant"
export CHAT_ID=$(uuidgen)

curl -N -s "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: text/event-stream" &
SSE_PID=$!
```

`-N` turns off buffering so events print as they arrive. The command runs in the background.

#### Send a Message

```bash
curl -s -X POST "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Summarize the benefits of cloud computing in 3 bullet points." }],
    "modelId": "gpt-4o",
    "outputFormat": "markdown"
  }' | jq .
```

```json
{
  "status": "streaming",
  "chatId": "550e8400-e29b-41d4-a716-446655440000"
}
```

POST body fields:

| Field | Type | Description |
| --- | --- | --- |
| `messages` | array | **Required.** Exactly one `{ role, content }` object, the new message; the server holds the history (see [Multi-turn conversation](#multi-turn-conversation)) |
| `modelId` | string | Override the app's default model |
| `outputFormat` | string | `markdown`, `text`, `json` or `html` |
| `language` | string | BCP 47 language code, for example `de` |
| `enabledTools` | array | Tool names to enable for this request |
| `thinkingEnabled` | boolean | Turn on extended thinking |
| `ephemeral` | boolean | First turn only: make the chat temporary (never listed or shared, deleted after `chats.temporaryRetentionHours`) |

#### Read the Events

Every frame is an SSE v2 envelope `{ v: 2, seq, runId, ts, type, data }`; the SSE `event:` field
carries the same `type`. One chat turn is one run:

```text
event: stream/connected
data: {"v":2,"seq":0,"runId":"550e8400-...","ts":"2026-03-16T10:30:00Z","type":"stream/connected","data":{"runId":"550e8400-...","lastSeq":0,"protocol":2}}

event: run/started
data: {"v":2,"seq":1,"runId":"chat-7f3a…","ts":"…","type":"run/started","data":{"kind":"chat","model":"gpt-4o","refs":{"chatId":"550e8400-...","appId":"chat-assistant"}}}

event: step/delta
data: {"v":2,"seq":2,"runId":"chat-7f3a…","ts":"…","type":"step/delta","data":{"step":0,"kind":"text","content":"Cloud computing"}}

event: step/completed
data: {"v":2,"seq":3,"runId":"chat-7f3a…","ts":"…","type":"step/completed","data":{"step":0,"content":"Cloud computing offers…","toolCalls":[],"finishReason":"stop"}}

event: run/ended
data: {"v":2,"seq":4,"runId":"chat-7f3a…","ts":"…","type":"run/ended","data":{"status":"completed","finishReason":"stop"}}
```

| Event | Description |
| --- | --- |
| `stream/connected` | Stream open; `lastSeq` is the last sequence number the server has for this stream |
| `run/started` | A run (one chat turn, or a workflow launched from the chat) began; `refs.messageId` links it to the message |
| `step/delta` | Streamed content; `kind` is `text`, `thinking` or `image` (concatenate the `content` of `text` deltas) |
| `step/completed` | One model call finished (`content`, `toolCalls`, `usage`, `citations`) |
| `tool/started` / `tool/progress` / `tool/completed` | Tool execution; `tool/progress` also carries search status, citations and grounding |
| `interaction/raised` | The model asks the user a question (`ask_user`); the run pauses (`run/paused`) |
| `meta` | Conversation title and IDs |
| `stream/error` | An error occurred; check `code` and `message` |
| `run/ended` | Answer complete; `status` and `finishReason` say why |

Full tables: [SSE v2 Streaming](sse-v2.md).

#### Multi-turn conversation

Every chat is stored server-side. For a follow-up, reuse the chat ID and post **only the new
message**; the server reads the rest of the history from its store:

```bash
curl -s -X POST "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "What are the main providers?" }] }' | jq .
```

A request with more than one message is refused with `400` and code `CLIENT_HISTORY_NOT_ALLOWED`.
Add `"ephemeral": true` to the first turn for a temporary chat that is not kept in the history. To
send the whole conversation yourself, use the stateless
[OpenAI-compatible API](#call-the-openai-compatible-api). See
[Chat Persistence](chat-persistence.md).

#### Stop and Clean Up

Stop an answer in progress (the server answers `204 No Content`), then close the stream:

```bash
curl -s -X POST "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID/stop" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

kill $SSE_PID 2>/dev/null
```

#### Without a Stream

The answer only ever arrives over the SSE stream; the POST answers `{ "status": "streaming" }` when
the turn has ended. Without an open stream the turn still runs and a kept chat stores its answer, but
nothing reaches the caller. For a single request and response, use the
[OpenAI-compatible API](#call-the-openai-compatible-api).

### Use a Static API Key

A [static API key](#static-api-keys) is used exactly like an access token, without the token
request:

```bash
export STATIC_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

curl -s -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $STATIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model": "gpt-4", "messages": [{ "role": "user", "content": "Hello with static key!" }] }' | jq .
```

### Get a User Token Instead

To act for a signed-in user rather than as a client, use the Authorization Code flow with PKCE (the
client needs the `authorization_code` grant). Full reference:
[OAuth Authorization Code Flow](oauth-authorization-code.md).

1. Generate the PKCE values and open the authorize URL in a browser:

   ```bash
   export CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')
   export CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" \
     | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_')
   export STATE=$(openssl rand -hex 16)
   export REDIRECT_URI="https://your-app.example.com/auth/callback"

   echo "$IHUB_API_URL/api/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid+profile+email&state=$STATE&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"
   ```

2. The user signs in and approves. The browser is redirected to
   `https://your-app.example.com/auth/callback?code=AUTH_CODE&state=STATE`.
3. Exchange the code (it expires after 10 minutes):

   ```bash
   export AUTH_CODE="the_code_from_callback"

   curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
     -H "Content-Type: application/json" \
     -d "{
       \"grant_type\": \"authorization_code\",
       \"code\": \"$AUTH_CODE\",
       \"redirect_uri\": \"$REDIRECT_URI\",
       \"client_id\": \"$CLIENT_ID\",
       \"code_verifier\": \"$CODE_VERIFIER\"
     }" | jq .
   ```

   The answer carries `access_token`, `id_token` and, if refresh tokens are enabled, a
   `refresh_token`.

4. Refresh the access token later:

   ```bash
   curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
     -H "Content-Type: application/json" \
     -d "{
       \"grant_type\": \"refresh_token\",
       \"refresh_token\": \"$REFRESH_TOKEN\",
       \"client_id\": \"$CLIENT_ID\"
     }" | jq .
   ```

`GET /api/auth/status` shows which sign-in methods the server offers (`authMethods.local`,
`authMethods.oidc` with its `providers`, and so on). A browser sign-in through an OIDC provider
(`/api/auth/oidc/<provider>`) ends in an `authToken` cookie, which suits browsers, not scripts.

### Test Error Cases

```bash
# Wrong credentials: 401 invalid_client
curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{ "grant_type": "client_credentials", "client_id": "invalid_client", "client_secret": "invalid_secret" }'

# Expired token, or no Authorization header: 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{ "model": "gpt-4", "messages": [{ "role": "user", "content": "Test" }] }'
```

Add `-v` to any curl command to see the full request and response headers, and `-o file.json` to
save a response.

### Complete Test Script

The script gets a token, checks it, lists models and apps, calls the OpenAI-compatible API and
chats with the first app over SSE. Save it as `test-oauth.sh`:

```bash
#!/bin/bash
set -euo pipefail

IHUB_API_URL="${IHUB_API_URL:-http://localhost:3000}"
CLIENT_ID="${CLIENT_ID:-your_client_id}"
CLIENT_SECRET="${CLIENT_SECRET:-your_client_secret}"

echo "1. Requesting an access token..."
TOKEN_RESPONSE=$(curl -s -X POST "$IHUB_API_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"client_credentials\",
    \"client_id\": \"$CLIENT_ID\",
    \"client_secret\": \"$CLIENT_SECRET\"
  }")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to get an access token:"
  echo "$TOKEN_RESPONSE" | jq .
  exit 1
fi
AUTH="Authorization: Bearer $ACCESS_TOKEN"

echo "2. Introspecting the token..."
curl -s -X POST "$IHUB_API_URL/api/oauth/introspect" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$ACCESS_TOKEN\", \"client_id\": \"$CLIENT_ID\", \"client_secret\": \"$CLIENT_SECRET\"}" | jq .

echo "3. Listing models..."
curl -s "$IHUB_API_URL/api/inference/v1/models" -H "$AUTH" | jq -r '.data[].id'

echo "4. Chat completion..."
curl -s -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{ "model": "gpt-4", "messages": [{ "role": "user", "content": "Say hello in one word" }], "max_tokens": 10 }' | jq .

echo "5. Listing apps..."
APP_ID=$(curl -s "$IHUB_API_URL/api/apps" -H "$AUTH" | jq -r '.items[0].id')
echo "   Using app: $APP_ID"

echo "6. Chatting over SSE..."
CHAT_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
curl -N -s "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID" -H "$AUTH" -H "Accept: text/event-stream" &
SSE_PID=$!
sleep 1
curl -s -X POST "$IHUB_API_URL/api/apps/$APP_ID/chat/$CHAT_ID" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "Say hello and tell me one fun fact. Keep it short." }] }' | jq .
kill $SSE_PID 2>/dev/null || true

echo "Done."
```

Run it:

```bash
export IHUB_API_URL="http://localhost:3000"
export CLIENT_ID="client_abc123"
export CLIENT_SECRET="your_secret"
chmod +x test-oauth.sh
./test-oauth.sh
```

## Token Management

### Static API Keys

For applications that cannot run the token request, generate a long-lived static API key for a
client:

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123/generate-token \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "expirationDays": 365 }'
```

`expirationDays` defaults to 365 and must be between 1 and 3650. A suspended client gets no key. The
answer is `201 Created`:

```json
{
  "api_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 31536000,
  "expires_at": "2027-01-19T10:00:00.000Z",
  "scope": "chat models"
}
```

> [!WARNING]
> Save the key immediately. It is not shown again.

Use it like an access token (see [Use a Static API Key](#use-a-static-api-key)).

### Token Introspection

See [Check a Token](#check-a-token).

## Security Best Practices

1. **Protect client secrets.** Never commit them to version control; keep them in environment
   variables or a secret manager; use different clients for development and production; rotate
   secrets regularly.
2. **Use HTTPS** in production, so credentials and tokens are encrypted in transit.
3. **Cache tokens.** Request a new token when the old one is about to expire, not for every call.
4. **Handle a `401`** by requesting a new token once and retrying; give up after a few attempts.
5. **Grant the minimum.** Give each client only the scopes, apps and models it needs:

   ```json
   {
     "scopes": ["chat"],
     "allowedApps": ["summarizer"],
     "allowedModels": ["gpt-4"]
   }
   ```

## Incident Response

### If a Secret Is Compromised

1. **Suspend the client.** Every token of a suspended client is refused at once (`403
   access_denied`):

   ```bash
   curl -X PUT https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123 \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "active": false }'
   ```

2. **Investigate.** Check **Admin → Audit Log** for changes to the client and the server logs for
   its requests.
3. **Rotate the secret.** Tokens issued before the rotation stop working (`401 invalid_token`,
   "Token was issued before the last secret rotation"):

   ```bash
   curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123/rotate-secret \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
   ```

   ```json
   {
     "clientId": "client_abc123",
     "clientSecret": "new_secret_xyz...",
     "rotatedAt": "2026-01-19T12:00:00.000Z"
   }
   ```

   The admin UI offers the same as **Rotate Client Secret** on the client.

4. **Update the application** with the new secret (`IHUB_CLIENT_SECRET`).
5. **Re-enable the client** with the same `PUT` and `{ "active": true }`.

## Troubleshooting

Errors of the OAuth endpoints have the form `{ "error": "...", "error_description": "..." }`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `400 invalid_request`, "OAuth is not enabled on this server" | `oauth.enabled.authz` is off | [Enable OAuth](#enable-oauth) |
| `400` "OAuth clients are not enabled on this server" (admin API) | `oauth.enabled.clients` is off | [Enable OAuth](#enable-oauth) |
| `400 invalid_request`, "client_id and client_secret are required" | A credential is missing from the request | Send both, in the body or as HTTP Basic |
| `400 unsupported_grant_type` | Wrong or missing `grant_type` | Use `client_credentials` |
| `400 invalid_scope` | A requested scope is not allowed for the client | Request only the client's scopes, or leave `scope` out |
| `401 invalid_client` | Wrong client ID or secret | Check for typos and whitespace; check the secret was not rotated |
| `403 access_denied` | The client is suspended | Ask an administrator to reactivate it |
| `401` on an API call | Token expired, invalid or missing | Request a new token; check the `Authorization` header |
| `401 invalid_token`, "Token was issued before the last secret rotation" | The secret was rotated | Request a new token with the new secret |
| `404 Not Found` | Wrong app ID or base path | Take the app ID from `/api/apps`; include a base path such as `/ihub` in the URL |
| SSE stream closes at once | The GET was not authorized | Check the token and the `Authorization` header |
| No events after the POST | The stream was not open yet | Open the GET before sending the POST |
| `400 invalid_grant` (authorization code) | The code expired (after 10 minutes) or was used | Start the authorization again |

## Related Documentation

- [OAuth Authorization Code Flow](oauth-authorization-code.md): user login from external apps
- [Personal API Keys](personal-api-keys.md): keys that act as one user
- [OpenAI-compatible API](openai-compatible-api.md): the `/api/inference/v1` endpoints
- [SSE v2 Streaming](sse-v2.md): the event stream in full
- [Authentication Architecture](authentication-architecture.md): all sign-in methods
- [RFC 6749: OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- API reference (Swagger UI): `/api/docs` on your server
