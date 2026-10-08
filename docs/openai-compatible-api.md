# OpenAI-Compatible API (Inference API)

iHub Apps exposes every configured model — and every iHub app — through an **OpenAI-compatible
HTTP API**. This lets you point any existing OpenAI client, SDK, or framework (Python `openai`,
the JavaScript SDK, LangChain, LlamaIndex, etc.) at iHub instead of directly at
OpenAI/Anthropic/Google/Mistral.

iHub acts as an authenticated, permission-aware proxy in front of all your providers:

- One endpoint and one credential for **all** models, regardless of the underlying provider.
- Provider API keys stay on the server — clients never see them.
- Access is filtered per user/group, so callers only see and use models they are allowed to.
- Usage is tracked in iHub telemetry (`inference-api` app id, `inference_api` metrics).
- **Apps are models.** `model: "app:<appId>"` runs an iHub app with its full server-side
  configuration — system prompt, variables, sources, tools and output schema — so a custom
  frontend sends only the input and gets the app's answer back, typed JSON included.
- Structured output is **validated on the server** before it is returned as a success.

> The proxy is implemented in `server/routes/openaiProxy.js` (plus `server/routes/inference/`
> for Responses and Conversations) and mounted under `/api/inference/v1`.

## Table of Contents

1. [Endpoints](#endpoints)
   - [Models and apps](#models-and-apps-the-model-field) — `app:<appId>[/<modelId>]`
   - [App variables](#app-variables-promptvariables) — `prompt.variables` and multi-turn rules
   - [Structured output](#structured-output) — `response_format`, `text.format`, validation
   - [Responses API](#responses-api) — `POST /responses`, streaming events
   - [Conversations API](#conversations-api) — stored conversations are iHub chats
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

| Method | Path                                                   | Description                                                        |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `GET`  | `/api/inference/v1/models`                             | Models **and apps** (`app:<appId>`) the caller may use             |
| `POST` | `/api/inference/v1/chat/completions`                   | Chat completion (streaming and non-streaming). Always stateless    |
| `POST` | `/api/inference/v1/responses`                          | Responses API subset. Stateless, or stateful with `conversation`   |
| `POST` | `/api/inference/v1/conversations`                      | Create a conversation (an iHub chat)                               |
| `GET` / `POST` / `DELETE` | `/api/inference/v1/conversations/{id}`  | Read, update metadata, delete                                      |
| `GET` / `POST` | `/api/inference/v1/conversations/{id}/items`   | List / add items (chat messages)                                   |
| `GET` / `DELETE` | `/api/inference/v1/conversations/{id}/items/{itemId}` | Read / remove one item                                  |

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
| `model`       | **Required.** An iHub model `id`, or an app: `app:<appId>` / `app:<appId>/<modelId>` (see [Models and apps](#models-and-apps-the-model-field)). |
| `messages`    | **Required.** Standard `role`/`content` array.                 |
| `stream`      | `true` streams Server-Sent Events back to you; default `false`. It describes *your* response only — see below. |
| `temperature` | `0`–`2`, default `0.7`.                                        |
| `max_tokens`  | Maximum tokens to generate.                                    |
| `tools`       | OpenAI tool/function definitions — translated to each provider.|
| `tool_choice` | `none` \| `auto` \| `{ ... }`.                                 |
| `stream_options` | `{ "include_usage": true }` appends a final chunk with `usage` (and empty `choices`) before `[DONE]`, as OpenAI does. |
| `response_format` | `{ "type": "json_object" }` or `{ "type": "json_schema", "json_schema": { "name", "schema", "strict" } }` — see [Structured output](#structured-output). Plain models only; an app brings its own schema. |
| `prompt`      | Apps only, an extension field (`extra_body` in the SDKs): `{ "variables": { … } }` — see [App variables](#app-variables-promptvariables). |
| `validate`    | `false` turns server-side output validation off (also `?validate=false`). |

Tool calling works across all providers: iHub converts OpenAI-format tools into its generic
format, dispatches to the provider, and converts the response (including streamed tool-call
deltas) back into OpenAI format.

#### `stream` shapes your response, not the provider call

iHub always streams from the provider. With `"stream": false` it collects that stream and
returns one `chat.completion` — the same body, `usage` included, that a buffered provider
response produced. Nothing changes for you as a client; it matters because a provider asked
for one buffered piece withholds its response headers until the whole answer is generated,
which made a slow-but-healthy model indistinguishable from an unreachable endpoint and
produced spurious `504 TIMEOUT` replies on longer jobs. See
[Stream deadlines](llm-client.md#stream-deadlines).

### Models and apps: the `model` field

| `model` value            | Meaning                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `<modelId>`              | A plain model, no app (e.g. `gpt-5`)                                                        |
| `app:<appId>`            | An app on its **default model**: the app's `preferredModel`, else the platform default       |
| `app:<appId>/<modelId>`  | An app on an **explicitly chosen model** (e.g. `app:nda-risk-analyzer/claude-sonnet-5`)     |

App ids and model ids cannot contain `:` or `/`, so the form is unambiguous.

- `GET /models` lists the permitted models, then the permitted apps as `app:<appId>`. It never
  lists `app:<appId>/<modelId>` combinations; those are accepted in requests. An app's allowed
  models, variables and output schema are published by `GET /api/apps/{appId}`
  (`preferredModel`, `allowedModels`, `variables`, `outputSchema`).
- An explicit model has to pass the same checks as in the chat UI: the caller needs permission
  for **both** the app and the model; the model must be in the app's `allowedModels` (with
  `disallowModelSelection: true` only the preferred model is accepted); and it must support what
  the app needs (tool calling, structured output). A violation is a `400`/`403`/`404` with a
  code saying which (`model_not_allowed_for_app`, `model_selection_disabled`,
  `model_capability_missing`, `model_access_denied`, `app_not_found`, …) — never a silent
  substitution.
- The response's `model` field echoes the resolved `app:<appId>/<modelId>`, so you can see which
  real model ran.
- The app configuration is authoritative: an app request must not carry `system`/`developer`
  messages, `instructions`, `response_format`/`text.format` or `tools` (`400`). Every enabled
  chat app is callable through the API; normal app permissions apply (for OAuth clients, the
  client's `allowedApps`).
- An app runs its tools on the server (web search, sources, MCP servers, workflows, …).
  `/chat/completions` returns only the final answer; `/responses` also reports each tool call as
  an `ihub_tool_call` output item.

### App variables: `prompt.variables`

The Responses API has a slot for server-side prompt templates with variables,
`prompt: { id, version, variables }`. An iHub app is exactly that, so it is reused — in
`/responses` directly, and as a top-level extension field in `/chat/completions`.

```jsonc
POST /api/inference/v1/responses
{
  "model": "app:summarizer/gpt-5",
  "prompt": {
    "id": "summarizer",        // optional; if present it must match the app in `model`
    "variables": {
      "action": "summarize",   // select → one of the predefinedValues
      "max_points": "5",       // number → numeric string or JSON number
      "include_quotes": true   // boolean → true/false or "true"/"false"
    }
  },
  "input": "…text to summarize…"
}
```

- **The app is chosen by `model` only.** `prompt.id` is optional (the OpenAI SDK types require
  it); when set it must equal the app id. `prompt.version` is ignored.
- Values are checked against the app's `variables` definitions: an unknown variable, a missing
  `required` one without a `defaultValue`, a value outside `predefinedValues`, or a value of the
  wrong type (`string`/`text` must be a string; `number` a number or numeric string; `boolean`
  true/false; `date` `YYYY-MM-DD`) — all problems come back together in one `400
  invalid_prompt_variables` with per-variable `details`.
- Missing optional variables get their `defaultValue` in the request language
  (`Accept-Language`), then the platform default language.
- **Files are not variables.** Send documents and images in `input` (`input_file` /
  `input_image`) or as Chat Completions content parts; a file-typed variable value is a `400`.
- `prompt` on a plain model is a `400` (`prompt_requires_app`): there is no server-side template.
- The template always comes from the app config; there is no way to send one.

#### Templates and variables across turns

| Turn | What the model receives |
| --- | --- |
| Stateless call, or the first turn of a conversation (no response has run in it yet — items you added yourself do not count) | The app's `prompt` template rendered with this turn's variables plus defaults, wrapping the input |
| Follow-up **without** `prompt.variables` | The raw input only — no template. The earlier rendered turns in the history carry it |
| Follow-up **with** `prompt.variables` | The template again, with exactly these variables plus defaults |

- In `/chat/completions` (stateless, you send the history) the template wraps only the **last**
  user message; earlier messages go to the model as you sent them.
- A conversation stores each user turn's raw input, the variables it was rendered with and the
  rendered text; history replay uses the rendered text, so the model sees exactly what it saw
  before.
- The **system prompt** is rebuilt on every call, and apps use variables there too
  (`ifinder-document-actions` needs `{{document-id}}` on every follow-up). It is rendered with
  the variables of the most recent turn that set them — stored on the conversation — then the
  defaults. A follow-up without `prompt.variables` keeps the system prompt stable; one with
  `prompt.variables` updates it.
- An app with `sendChatHistory: false` answers every turn without history, so its template wraps
  every turn (with the conversation's stored variables when a follow-up sends none).

### Structured output

Structured output can be asked for in three ways; they all map onto the provider's native
mechanism (OpenAI strict `json_schema`, Anthropic forced tool call, Google `responseSchema`,
Mistral `json_schema`, vLLM):

| Where | How |
| --- | --- |
| `/chat/completions`, plain model | `response_format: { type: "json_object" }` or `{ type: "json_schema", json_schema: { name, schema, strict } }` |
| `/responses`, plain model | `text: { format: { type: "json_schema", name, schema, strict } }` (or `json_object`) |
| Any endpoint, app | The app's `outputSchema`, applied automatically |

- Anthropic's forced tool call comes back as plain `message.content` JSON, like OpenAI's.
- Models without native enforcement (Bedrock) get the schema as a system instruction, and the
  server check below strips Markdown fences and surrounding text. A model that cannot do
  structured output at all (iAssistant, or `supportsStructuredOutput: false`) is a `400
  structured_output_not_supported`.
- **Server-side validation** (on by default): the answer is parsed and validated against the
  schema. What you get back is the validated JSON (fences and prose removed). An answer that
  does not validate is retried **once**, with the validation errors fed back to the model; if the
  retry fails too, the request fails with `422 output_validation_failed` and the errors in
  `details`. An unvalidated answer is never returned as a success.
- **Streaming:** `/responses` streams the first attempt and, when it does not validate, closes
  that message item as `incomplete` and streams the retry as a new item; `response.completed`
  carries only the validated output. `/chat/completions` cannot take streamed text back, so a
  streamed answer is validated at the end without a retry and, if invalid, the stream ends with an
  in-band error (`code: "output_validation_failed"`), which the OpenAI SDKs raise as an error.
- Schemas are checked in the draft they declare (`$schema` naming 2020-12 or 2019-09;
  draft-07 otherwise). `pattern` checks run under a time limit, and a caller's schema with a
  known catastrophic `pattern` (nested quantifiers such as `(a+)+`) is refused with `400
  invalid_json_schema`.
- **Opt out** with `?validate=false`, or `validate: false` in the body (`extra_body` in the SDKs).
- Validation outcomes are counted in the `ihub.structured_output.validation` metric; a rejected
  attempt is recorded in the run ledger as a recoverable `error` event followed by the correction
  (`message/user`, `synthetic: "nudge"`).

### Responses API

`POST /api/inference/v1/responses` implements a subset of the OpenAI Responses API:

| Field | Notes |
| --- | --- |
| `model` | **Required.** Model id or app (`app:<appId>[/<modelId>]`) |
| `input` | **Required.** A string, or message items `{ role, content }` whose content parts are `input_text`, `input_image` (`image_url` as a `data:` URL) and `input_file` (`file_data` as a `data:` URL plus `filename`; PDF, Word (`.docx`), PowerPoint (`.pptx`) and text files — the text is extracted on the server, see [Documents](#documents)). Earlier `assistant` messages (`output_text`) may be included. The last item must be a user message |
| `instructions` | System instructions — plain models only |
| `prompt` | App variables — apps only |
| `text.format` | `text`, `json_object` or `json_schema` — plain models only |
| `conversation` | A conversation id (or `{ id }`): load its history and append this turn |
| `stream` | Semantic streaming events (below) |
| `temperature`, `max_output_tokens`, `metadata` | As in OpenAI |
| `store` | Ignored: only a `conversation` persists |

Not supported, answered with `400 unsupported_parameter`: `previous_response_id` (use
`conversation`), `background`, `tools` (OpenAI-hosted tools do not exist here; an app runs its
own) and `tool_choice` other than `auto`/`none`. Provider-hosted file references (`file_id`,
`file_url`) and remote image URLs are refused too — send files inline.

The response is a standard `response` object: `output[]` holds `message` items (`output_text`
content; for structured output the text is the validated JSON and `parsed` carries the parsed
object), and for apps `ihub_tool_call` items `{ id, call_id, name, arguments, output, status }`
for the tools the app ran. They are deliberately not `function_call` items, which would tell an
agent framework to execute the call itself. `usage` has `input_tokens`, `output_tokens` and
`total_tokens`. Reasoning is not forwarded.

Streaming (`stream: true`) sends `event:`/`data:` pairs with a `sequence_number`:
`response.created`, `response.in_progress`, `response.output_item.added`,
`response.content_part.added`, `response.output_text.delta`, …, `response.output_text.done`,
`response.content_part.done`, `response.output_item.done`, and finally `response.completed`
(carrying the final, validated response — the OpenAI SDKs take it as the final response) or
`response.failed` (with `response.error`).

### Documents

Files travel inline (`input_file` in the Responses API, `file` content parts in Chat Completions): a `data:` URL or base64 with a `filename`. The server turns them into text the same way the chat upload does, so a file reads the same through the API as in the browser (see [File Upload → Extracted text format](file-upload-feature.md#extracted-text-format)):

| File | What the model reads |
| --- | --- |
| PDF | `[Page N]` before each page (`[Page 5 (printed: 3)]` when the page's printed number differs), one line per line of the page, `#` headings and Markdown tables where the PDF is tagged or has an outline, `[Page 2: no extractable text]` for a page without text. At most 500 pages and 500,000 characters per file |
| Word (`.docx`) | Markdown with `#` headings, the numbers Word shows in front of headings and list items, tables, footnotes, `[Page break]`, and `[Header]` / `[Footer]` lines. Tracked changes are applied and comments left out |
| PowerPoint (`.pptx`) | `[Slide N]` in the order of the presentation (`[Slide 3 (hidden)]` for a hidden slide), titles as `# Title`, tables as Markdown tables. Speaker notes are not sent |
| Text types | Read as UTF-8 |

Excel files are not accepted through the API (`unsupported_file_type`): reading them needs the SheetJS library, which the server does not carry. Send the data as CSV or text.

Errors, all `400`: `invalid_file` (not a readable PDF, Word or PowerPoint file, empty data, or a package that is damaged or would unpack to an unreasonable size: more than 5,000 parts, 30 MB for one part or 100 MB in total), `file_has_no_text` (a scanned PDF or an empty Word or PowerPoint file — send the pages as `input_image`) and `unsupported_file_type`.

The admin switch **Structured document extraction** (Admin → Features) applies here as well: when it is off, PDFs are read as one run of words per page without markers and Word files are not accepted, as before.

### Conversations API

A conversation **is an iHub chat**. Its id is the chat id (no `conv_` prefix), it shows up in
the owner's iHub chat history, and ownership works as for any chat: another caller gets `404`.
For an OAuth client-credentials caller the owner is the technical client; for a personal API key
it is the key's owner. Conversations need chat persistence (`chatPersistence` feature and
`platform.chats`); without it they answer `503 conversations_unavailable`, and anonymous callers
get `401`.

- `POST /conversations` creates one, optionally with up to 20 text `items` (user/assistant) and
  `metadata` (up to 16 string pairs). It is not tied to an app yet.
- `POST /responses` with `conversation` loads the history, runs the turn and appends its input
  and output. The **first response binds the conversation** to the app part of its `model` (or
  to "plain model"); a later response for a different app is a `400
  conversation_app_mismatch`. Switching the real model within the same app
  (`app:x/model-a` → `app:x/model-b`) is fine, as in the UI.
- Only one response runs in a conversation at a time; a second concurrent one gets `409
  conversation_busy` (nothing is stored, so it can be sent again). A conversation turn is stored
  even if your client disconnects mid-way; Stop in the iHub UI or `DELETE /conversations/{id}`
  aborts it (`409 turn_aborted`).
- A follow-up without `prompt.variables` does not have to repeat the app's required variables:
  it runs on the ones the conversation already has.
- Once a conversation turn is stored, a failure answers with `x-should-retry: false`, which
  tells the OpenAI SDKs not to repeat the request on their own — the question is already in
  the conversation. Send it again deliberately if you want another attempt.
- `GET /conversations/{id}/items` (`limit` 1–100, default 20; `order` `desc` by default;
  `after`) returns the messages as items: a user item holds the **raw input** (the variables it
  was rendered with in `metadata.variables`, attached files as `input_file` entries with their
  names); an assistant item holds the answer, the **validated JSON as `parsed`** and the model
  that produced it in `metadata.model`. A failed answer is `status: "incomplete"` with
  `metadata.error`.
- `POST /conversations/{id}` updates `metadata`; `DELETE /conversations/{id}` deletes the chat
  with its runs; `POST`/`GET`/`DELETE` on `/items` add, read and remove items.
- The chat records how it came about: `origin: { createdVia: "responses-api", clientId?,
  authMode }` (chats started in the UI carry `createdVia: "ui"`).

### Using apps from the `openai` SDKs

```python
import json
from openai import OpenAI

client = OpenAI(base_url="https://your-ihub-instance.com/api/inference/v1", api_key=IHUB_TOKEN)

# Stateless, the app's configured model and schema
resp = client.responses.create(
    model="app:nda-risk-analyzer",
    input=[{"role": "user", "content": [
        {"type": "input_file", "filename": "nda.pdf", "file_data": f"data:application/pdf;base64,{pdf_b64}"},
    ]}],
)
result = json.loads(resp.output_text)   # the validated JSON; the message item also carries it as `parsed`

# Stateful: a conversation is an iHub chat
conv = client.conversations.create()
client.responses.create(model="app:summarizer", conversation=conv.id,
                        prompt={"id": "summarizer", "variables": {"action": "summarize"}},
                        input="…")
client.responses.create(model="app:summarizer", conversation=conv.id, input="Shorter, please.")
items = client.conversations.items.list(conv.id, order="asc")

# Chat Completions: variables through extra_body
client.chat.completions.create(
    model="app:summarizer",
    messages=[{"role": "user", "content": "…"}],
    extra_body={"prompt": {"variables": {"action": "summarize"}}},
)
```

See [Structured Output → External API usage](structured-output.md#external-api-usage) for more
examples (curl, JavaScript, streaming).

### Tool calling with Gemini — thought signatures

Thinking Gemini models (the 2.5 and 3 series) return a **thought signature** on tool calls: an
encrypted snapshot of the model's reasoning that Gemini requires back in the conversation
history. Gemini 3 validates this strictly and rejects a continuation request whose current-turn
function calls are missing it:

```
400 ... Function call is missing a thought_signature in functionCall parts.
```

Gemini puts the signature on the **first** tool call of a response — with parallel tool calls,
the rest carry none. Preserve it on exactly the call it came back on; do not copy it onto the
others or synthesise one where there was none.

The OpenAI schema has no field for this, so iHub follows Google's own compatibility
convention and nests the signature inside the tool call it belongs to:

```json
{
  "id": "call_0_1732531200000",
  "type": "function",
  "function": { "name": "get_weather", "arguments": "{\"city\":\"Berlin\"}" },
  "extra_content": { "google": { "thought_signature": "AgQKA..." } }
}
```

**What callers should do:** echo the assistant message's `tool_calls` back **verbatim**,
including `extra_content`, alongside the `role: "tool"` result. Reconstructing tool calls
field-by-field, or using a client that drops unknown fields, loses the signature.

This is the same field Gemini-aware OpenAI clients already handle. [Hermes
Agent](https://github.com/NousResearch/hermes-agent), for example, captures `extra_content`
off each tool call — including from the OpenAI SDK's unknown-field bag — and replays it when
the model name looks Gemini-family, so it works against iHub with no changes.

> **Name your Gemini models with `gemini` (or `gemma`) in the id.** Clients decide whether to
> replay `extra_content` by pattern-matching the model name, because on a plain OpenAI
> endpoint that is the only signal they have. A Gemini-backed model published as, say,
> `fast-assistant` will have its signature dropped by such a client and fall back to the
> degraded path below.

If the signature does not come back, iHub substitutes Google's documented
`skip_thought_signature_validator` sentinel on the affected function call so the request
succeeds instead of failing with a 400. The conversation continues, but the model loses the
reasoning context behind that tool call, which can degrade multi-step tool use — so
round-tripping the real signature is always preferable. iHub logs a warning
(`No thought signature for current-turn function call`) whenever it falls back.

`extra_content` is only present when the upstream model actually returned a signature, so
responses from other providers are unchanged. And because strict providers (Mistral,
Fireworks, …) reject a request that *carries* the field, iHub strips it from outgoing
`tool_calls` whenever the target model is not Gemini-family — so replaying a Gemini
conversation against a different model is safe.

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
    { "object": "model", "id": "claude-3" },
    { "object": "model", "id": "app:nda-risk-analyzer" }
  ]
}
```

The list is filtered to the models and apps the authenticated caller is permitted to use.

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

- `GET /api/inference/v1/models` returns only models (and apps) the caller may use.
- `POST /api/inference/v1/chat/completions` returns **403** if the caller lacks access to the
  requested model, and **404** if the model id does not exist.
- An app (`app:<appId>`) needs the app permission (`apps` in the group, or the OAuth client's
  `allowedApps`) and, for an explicit model, the model permission as well. An app the caller may
  not use answers `404 app_not_found`, like `GET /api/apps/{appId}`.

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

## Errors

Errors are JSON objects with a `code` from iHub's canonical LLM error taxonomy
(see [LLM Client](llm-client.md#error-taxonomy)):

```json
{ "error": "Rate limit exceeded for openai API. Please try again later.", "code": "RATE_LIMITED", "details": "<raw provider body>" }
```

That flat shape is what `/chat/completions` returns. `/responses` and `/conversations` use
OpenAI's nested shape:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": "prompt.variables", "code": "invalid_prompt_variables", "details": [ … ] } }
```

- Provider failures keep the **upstream HTTP status** (`429`, `503`, …) and carry the provider's
  raw response in `details`.
- Validation failures use `400`/`403`/`404` with a localized `error` message (`Accept-Language`
  selects the language).
- When a **stream** fails after it started, the error is sent in-band as
  `data: {"error": {"message": …, "type": "server_error", "code": …}}` followed by `data: [DONE]`.
- If the client disconnects mid-stream the upstream model call is aborted immediately.

## Limitations

- **Authentication follows the platform.** The endpoint sits behind `authRequired`: when anonymous
  access is disabled on the platform, a token is required; when it is enabled, unauthenticated
  calls are served and see every enabled model. Restrict access with groups / OAuth client scopes.
- **Reasoning content is not forwarded.** Provider "thinking" deltas are consumed server-side and
  never appear in the OpenAI wire.
- **Compatibility scope.** The API implements `models`, `chat/completions`, a subset of
  `responses` and `conversations`. Other OpenAI endpoints (legacy `completions`, `embeddings`,
  `images`, `files`) are not exposed here; responses are not stored or retrievable by id (use a
  conversation).
- **App requests are stateless in `/chat/completions`.** Use `/responses` with a `conversation`
  for a stored, multi-turn chat.

---

## Troubleshooting

| Symptom                          | Likely cause / fix                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `401 Authentication required`    | Missing/expired token. Re-request an OAuth token or check the static key's expiry. |
| `403` model access denied        | The caller's group / OAuth client is not granted the requested model.              |
| `404` model not found            | The `model` id does not match any configured model. Check `GET .../models`.        |
| `404 app_not_found`              | The app does not exist, is disabled, or the caller may not use it.                 |
| `400 model_not_allowed_for_app`  | The model after `app:<appId>/` is not in the app's `allowedModels` (see `GET /api/apps/{appId}`). |
| `400 invalid_prompt_variables`   | `prompt.variables` does not match the app's variables; `details` lists every problem. |
| `422 output_validation_failed`   | The model's answer did not match the schema, also after the retry. `details` lists the errors. |
| `409 conversation_busy`          | Another response is still running in the conversation.                             |
| `503 conversations_unavailable`  | Chat persistence is off; conversations need it.                                    |
| `429 Too many requests`          | Inference rate limit hit. Back off or raise `rateLimit.inferenceApi.limit`.        |
| `500` API key not found          | The underlying provider's API key is not configured on the server.                 |
| `400 missing a thought_signature` (Gemini) | The tool call was sent back without its `extra_content.google.thought_signature`. Echo `tool_calls` verbatim — see [Tool calling with Gemini](#tool-calling-with-gemini--thought-signatures). |
| Empty/blocked from a browser     | Add your origin to the `cors` configuration (see Server Configuration).            |
