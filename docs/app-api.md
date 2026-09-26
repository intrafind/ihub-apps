# App API

The **App API** lets an external program talk to an iHub **app** — not just a model — the way a
user does in the chat: the app's system prompt, variables, sources, tools and skills all apply,
tools run on the server, and the answer streams back in the shape an OpenAI client expects. It
is the machine-facing counterpart of the chat UI, and the foundation for embedding an app on
another site.

> Implemented in `server/routes/appApi.js`, mounted under `/api/v1`. For raw model access with
> your own tools, see the [OpenAI-Compatible API](openai-compatible-api.md) under
> `/api/inference/v1`.

## Table of Contents

1. [Endpoints](#endpoints)
2. [Authentication and access](#authentication-and-access)
3. [Chat completions](#chat-completions)
4. [Attachments](#attachments)
5. [Stored conversations](#stored-conversations)
6. [Errors](#errors)
7. [Limitations](#limitations)

---

## Endpoints

| Method | Path                                      | Purpose                                                   |
| ------ | ----------------------------------------- | --------------------------------------------------------- |
| `POST` | `/api/v1/apps/{appId}/chat/completions`   | Run the app on a conversation; OpenAI chat-completion shape |
| `POST` | `/api/v1/attachments`                     | Upload a file to reference from a user message             |

Both endpoints are rate-limited by the `inferenceApi` limiter (see [Rate Limiting](rate-limiting.md))
and documented with `@swagger` annotations (tag **App API**) in the running server's API docs.

## Authentication and access

Authenticate like everywhere else on the API: `Authorization: Bearer <token>` with a
**personal API key** (Settings → Integrations) or an **OAuth 2.0 access token** (client
credentials or authorization code; see the [OAuth Integration Guide](oauth-integration-guide.md)).
The caller's groups decide which apps it may call, exactly as in the UI: an app the caller cannot
open answers `404`. When the platform allows anonymous access, unauthenticated calls are served
with the anonymous groups; uploads always need a signed-in caller.

## Chat completions

```bash
curl https://ihub.example.com/api/v1/apps/chat/chat/completions \
  -H "Authorization: Bearer $IHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Summarize our refund policy in three sentences." }],
    "stream": false
  }'
```

```json
{
  "id": "chatcmpl-3f2c…",
  "object": "chat.completion",
  "created": 1790000000,
  "model": "gpt-4o",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 812, "completion_tokens": 96, "total_tokens": 908 }
}
```

### Request fields

| Field            | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `messages`       | The conversation, `user` and `assistant` roles. The last message must be the user's.                      |
| `stream`         | `true` for Server-Sent Events (`chat.completion.chunk` objects, then `data: [DONE]`).                      |
| `stream_options` | `{ "include_usage": true }` adds a final chunk with `usage` and empty `choices`.                          |
| `model`          | Optional model override; checked against the app's models and the caller's model permissions.            |
| `temperature`    | Optional; the app's default applies otherwise.                                                            |
| `max_tokens`     | Optional cap on the answer length, never above the model's configured maximum.                            |
| `variables`      | **Extension.** App variables for the prompt template, `{ "name": "value" }`.                              |
| `chat_id`        | **Extension.** Store the conversation server-side and continue it later (see below).                      |
| `language`       | **Extension.** Response language; defaults to `Accept-Language`, then the platform default.               |

`content` is a string or an array of OpenAI content parts: `text`, `image_url` (a `data:` URL —
remote image URLs are not fetched) and `file` (`file_data` as a `data:` URL with `filename`, or
`file_id` of an uploaded attachment). A `system` message is refused with `400`: the app's own
prompt applies; put instructions in the user message or in `variables`.

The app runs exactly as in the chat — server-side tool calls, sources, skills, structured output
— but headlessly: a tool that asks the user a question (`ask_user`) is refused because nobody can
answer it. Tool progress is not part of the stream; only the answer text is.

### Streaming

```bash
curl -N https://ihub.example.com/api/v1/apps/chat/chat/completions \
  -H "Authorization: Bearer $IHUB_API_KEY" -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "Hello" }], "stream": true }'
```

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}],…}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}],…}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],…}
data: [DONE]
```

An OpenAI SDK works unchanged with `base_url = "https://ihub.example.com/api/v1/apps/<appId>"`
and any `model` value (the app decides; the field is optional here).

## Attachments

Upload a file first, then reference it on the user message:

```bash
curl https://ihub.example.com/api/v1/attachments \
  -H "Authorization: Bearer $IHUB_API_KEY" \
  -F "file=@quarterly-report.pdf"
# → { "id": "att_3f2c9d1e…", "object": "attachment", "filename": "quarterly-report.pdf",
#     "mime_type": "application/pdf", "size": 182331, "expires_at": "…" }

curl https://ihub.example.com/api/v1/apps/chat/chat/completions \
  -H "Authorization: Bearer $IHUB_API_KEY" -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "What changed versus last quarter?",
                       "attachments": ["att_3f2c9d1e…"] }] }'
```

- Uploads are `multipart/form-data`, field `file`, at most **20 MB**, and are processed like the
  chat's uploads: **PDFs** and **text formats** (`txt`, `md`, `csv`, `json`, `xml`, `html`, `yaml`,
  code) are read as documents whose text reaches the model; **images** (`png`, `jpeg`, `gif`,
  `webp`) are shown to vision models. A PDF without a text layer (a scan) is refused with `415`;
  other formats (Office documents, archives) are not supported.
- An attachment belongs to the caller who uploaded it and expires after **24 hours**; unknown,
  expired or foreign ids answer `404`. `attachments` is also accepted under `metadata.attachments`.
- Attachments count only on the **last** user message of the request. Tools that take files
  (MCP file inputs) receive the uploaded bytes.
- Inline alternatives: an `image_url` part or a `file` part with `file_data`, both as `data:`
  URLs, need no upload step.

## Stored conversations

Without `chat_id` a call is stateless: post the whole conversation each time and nothing is
stored. With `chat_id` the conversation is stored on the server, exactly like a chat in the UI:

- To **start** one, pass a fresh id (letters, digits, `.`, `-`, `_`; a UUID works) with the first
  user message. To **continue**, pass the same id with **only the new user message**; the stored
  history is prepended (unless the app has chat history turned off). Posting more than one
  message to a stored chat answers `400 CLIENT_HISTORY_NOT_ALLOWED`.
- The answer carries `chat_id`, and the conversation appears in the caller's chat history in the
  UI. A stored chat belongs to the caller who created it; another caller gets `404`.
- Requires chat persistence to be active for the caller (feature on, signed-in user); otherwise
  `400 CHAT_PERSISTENCE_UNAVAILABLE`.

## Errors

Errors are JSON `{ "error": "<message>", "code": "<CODE>" }`, with `4xx` for request problems
(`APP_NOT_FOUND`, `SYSTEM_MESSAGE_NOT_ALLOWED`, `ATTACHMENT_NOT_FOUND`, `FILE_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`, `CHAT_NOT_FOUND`, …) and `5xx` for provider failures (`502`, `504`).
When a stream fails after it started, the error is sent in-band as
`data: {"error": {"message": …, "type": "server_error", "code": …}}` followed by `data: [DONE]`.
A client that disconnects mid-stream aborts the running turn.

## Limitations

- **Text answers only.** Generated images and MCP App views are not part of the response; tool
  activity is not streamed.
- **No clarification questions.** Interactive tools are refused in this headless setting.
- **Attachments are documents and images.** Audio and video uploads, and Office formats, are not
  processed; scanned PDFs need OCR before upload.
- **One caller, one app.** The request runs as the caller; the app-as-tool chain and MCP gateway
  rules for nested apps apply unchanged.
