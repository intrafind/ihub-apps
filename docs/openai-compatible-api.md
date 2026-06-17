# OpenAI-Compatible API (Inference API)

iHub Apps exposes every configured model through an **OpenAI-compatible HTTP API**. This lets
you point any existing OpenAI client, SDK, or framework (Python `openai`, the JavaScript SDK,
LangChain, LlamaIndex, etc.) at iHub instead of directly at OpenAI/Anthropic/Google/Mistral.

iHub acts as an authenticated, permission-aware proxy in front of all your providers:

- One endpoint and one credential for **all** models, regardless of the underlying provider.
- Provider API keys stay on the server — clients never see them.
- Access is filtered per user/group, so callers only see and use models they are allowed to.
- Usage is tracked in iHub telemetry (`inference-api` app id, `inference_api` metrics).

> The proxy is implemented in `server/routes/openaiProxy.js` and mounted under
> `/api/inference/v1`.

## Table of Contents

1. [Endpoints](#endpoints)
2. [Setup](#setup) — enabling access and issuing credentials
3. [Using the API](#using-the-api) — curl, Python, JavaScript, LangChain
4. [Configuration](#configuration) — model permissions and rate limiting
5. [Reference & related docs](#reference--related-docs)
6. [Limitations](#limitations)
7. [Troubleshooting](#troubleshooting)

---

## Endpoints

The proxy mounts under `/api/inference/v1` and reuses iHub's standard authentication. All
endpoints require authentication — there is no anonymous access to the inference API.

| Method | Path                              | Description                                            |
| ------ | --------------------------------- | ------------------------------------------------------ |
| `GET`  | `/api/inference/v1/models`        | List models the caller is allowed to use (OpenAI form) |
| `POST` | `/api/inference/v1/chat/completions` | Create a chat completion (streaming and non-streaming) |

The `base_url` you give an OpenAI client is therefore:

```
https://your-ihub-instance.com/api/inference/v1
```

> If iHub is deployed under a subpath (e.g. `/ihub`), the base path is included automatically:
> `https://your-host/ihub/api/inference/v1`.

### Supported request fields

`POST /api/inference/v1/chat/completions` accepts the common OpenAI Chat Completions fields:

| Field         | Notes                                                          |
| ------------- | -------------------------------------------------------------- |
| `model`       | **Required.** An iHub model `id` (see `GET .../models`).        |
| `messages`    | **Required.** Standard `role`/`content` array.                 |
| `stream`      | `true` streams Server-Sent Events; default `false`.            |
| `temperature` | `0`–`2`, default `0.7`.                                        |
| `max_tokens`  | Maximum tokens to generate.                                    |
| `tools`       | OpenAI tool/function definitions — translated to each provider.|
| `tool_choice` | `none` \| `auto` \| `{ ... }`.                                 |

Tool calling works across all providers: iHub converts OpenAI-format tools into its generic
format, dispatches to the provider, and converts the response (including streamed tool-call
deltas) back into OpenAI format.

---

## Setup

The inference API uses the **same authentication** as the rest of iHub. Any valid credential
works: an interactive session cookie, an OIDC/JWT bearer token, a proxy-auth header, or — most
commonly for programmatic access — an OAuth client-credentials token or a static API key.

Pick the option that matches your caller:

### Option A — Use an existing user session / SSO token

If your caller already authenticates against iHub (browser session, OIDC, proxy header, or JWT),
no extra setup is needed. Send the token as a bearer header (or rely on the session cookie) and
the proxy will apply that user's model permissions. See
[Authentication Architecture](authentication-architecture.md).

### Option B — OAuth 2.0 client credentials (recommended for machine-to-machine)

Best for external systems and automation. You get short-lived tokens with explicitly scoped
model access.

1. **Enable OAuth** in `contents/config/platform.json` and restart the server:

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

2. **Create an OAuth client** (admin token required), restricting it to the models it may use:

   ```bash
   curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "My Integration",
       "scopes": ["chat", "models"],
       "allowedModels": ["gpt-4", "claude-3"],
       "tokenExpirationMinutes": 60
     }'
   ```

   Save the returned `clientSecret` — it is shown only once.

3. **Request an access token** at runtime:

   ```bash
   ACCESS_TOKEN=$(curl -s -X POST https://your-ihub-instance.com/api/oauth/token \
     -H "Content-Type: application/json" \
     -d '{
       "grant_type": "client_credentials",
       "client_id": "client_abc123...",
       "client_secret": "d4f5e6a7b8c9...",
       "scope": "chat models"
     }' | jq -r '.access_token')
   ```

   Use `$ACCESS_TOKEN` as the bearer credential. Full details, rotation, and introspection are in
   the [OAuth Integration Guide](oauth-integration-guide.md).

### Option C — Static (long-lived) API key

For clients that cannot run the OAuth flow, generate a long-lived key for an existing OAuth
client:

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients/client_abc123/generate-token \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "expirationDays": 365 }'
```

The response contains an `api_key` (shown only once). Use it directly as the bearer token — it
behaves exactly like an OAuth access token but with a long expiry. Treat it as a secret and
rotate it periodically.

---

## Using the API

All examples assume:

```bash
export IHUB_API_URL="https://your-ihub-instance.com"
export IHUB_TOKEN="<oauth-access-token-or-static-api-key>"
```

### List available models

```bash
curl -s -X GET "$IHUB_API_URL/api/inference/v1/models" \
  -H "Authorization: Bearer $IHUB_TOKEN" | jq .
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

The list is filtered to the models the authenticated caller is permitted to use.

### Chat completion (curl)

```bash
curl -s -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $IHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello, this is a test!" }
    ],
    "temperature": 0.7,
    "max_tokens": 100
  }' | jq .
```

### Streaming (curl)

Set `"stream": true` to receive Server-Sent Events terminated by `data: [DONE]`:

```bash
curl -N -X POST "$IHUB_API_URL/api/inference/v1/chat/completions" \
  -H "Authorization: Bearer $IHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "stream": true,
    "messages": [{ "role": "user", "content": "Write a haiku about proxies." }]
  }'
```

### Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-ihub-instance.com/api/inference/v1",
    api_key="<oauth-access-token-or-static-api-key>",
)

resp = client.chat.completions.create(
    model="gpt-4",  # any model id from /api/inference/v1/models
    messages=[{"role": "user", "content": "Hello from the OpenAI SDK!"}],
)
print(resp.choices[0].message.content)

# Streaming
for chunk in client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Stream this."}],
    stream=True,
):
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

### JavaScript / TypeScript (`openai` SDK)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-ihub-instance.com/api/inference/v1',
  apiKey: process.env.IHUB_TOKEN
});

const completion = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello from the JS SDK!' }]
});

console.log(completion.choices[0].message.content);
```

### LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4",
    base_url="https://your-ihub-instance.com/api/inference/v1",
    api_key="<oauth-access-token-or-static-api-key>",
)

print(llm.invoke("Hello from LangChain!").content)
```

> **Token rotation note:** OAuth access tokens expire. For long-running processes, refresh the
> token (Option B) and recreate the client, or use a static API key (Option C) with an appropriate
> expiry.

---

## Configuration

### Model access (permissions)

The proxy enforces iHub's group-based permissions on every request:

- `GET /api/inference/v1/models` returns only models the caller may use.
- `POST /api/inference/v1/chat/completions` returns **403** if the caller lacks access to the
  requested model, and **404** if the model id does not exist.

Model access is governed by:

- The user's group permissions in [`config/groups.json`](platform.md) (the `models` permission
  list, including `"*"` for all models).
- For OAuth clients, additionally the client's `allowedModels` / scopes set when the client was
  created.

There is nothing inference-specific to enable beyond having models configured (see [Models](models.md))
and granting the caller access to them.

### Rate limiting

Inference requests are governed by the dedicated **Inference API rate limiter**, applied to all
`/inference/*` routes. The built-in default is **500 requests per minute per IP**. Override it in
`contents/config/platform.json`:

```json
{
  "rateLimit": {
    "inferenceApi": {
      "windowMs": 60000,
      "limit": 500
    }
  }
}
```

When a limit is exceeded the API returns **429** with `RateLimit-*` headers. See
[Rate Limiting](rate-limiting.md) for all options.

### CORS (browser callers)

If you call the inference API from a browser on another origin, add that origin to the `cors`
configuration in `platform.json` and send credentials as needed. See the CORS section of
[Server Configuration](server-config.md).

---

## Reference & related docs

The inference API is documented across the codebase and docs set. This page consolidates them; the
primary sources are:

1. **[Server Configuration → OpenAI-Compatible Proxy](server-config.md)** — the canonical
   description of the proxy and its endpoints.
2. **[OAuth Integration Guide](oauth-integration-guide.md)** — credential issuance and end-to-end
   `curl` examples for tokens and static API keys.
3. **In-product Swagger / OpenAPI docs** — `server/routes/openaiProxy.js` carries full `@swagger`
   annotations (tag **"OpenAI Compatible"**) with request/response schemas, available from the
   running server's API docs.
4. **Supporting references** — [Rate Limiting](rate-limiting.md) (`inferenceApi` limiter),
   [Telemetry & Observability](telemetry.md) (`inference_api` metrics, `inference-api` app id),
   and [Admin UI Guide](admin-ui.md) (model/provider configuration).

---

## Limitations

- **Authentication is always required.** Anonymous access is not available on this endpoint, even
  if anonymous access is enabled elsewhere on the platform.
- **`usage` token counts are not populated** in non-streaming responses — `prompt_tokens`,
  `completion_tokens`, and `total_tokens` are returned as `0`. Use iHub telemetry for accurate
  usage accounting.
- **Compatibility scope.** The proxy implements `chat/completions` and `models`. Other OpenAI
  endpoints (e.g. legacy `completions`, `embeddings`, `images`) are not exposed here.

---

## Troubleshooting

| Symptom                          | Likely cause / fix                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `401 Authentication required`    | Missing/expired token. Re-request an OAuth token or check the static key's expiry. |
| `403` model access denied        | The caller's group / OAuth client is not granted the requested model.              |
| `404` model not found            | The `model` id does not match any configured model. Check `GET .../models`.        |
| `429 Too many requests`          | Inference rate limit hit. Back off or raise `rateLimit.inferenceApi.limit`.        |
| `500` API key not found          | The underlying provider's API key is not configured on the server.                 |
| Empty/blocked from a browser     | Add your origin to the `cors` configuration (see Server Configuration).            |
