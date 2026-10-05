# Magic Prompt Feature Documentation

## Overview

The magic prompt feature refines the user's input by sending it to an LLM with a configurable system prompt. The returned text replaces the current input so that users can easily start with a high-quality prompt. A convenient undo option lets them revert back to their original text.

## App Configuration

Enable and configure the feature for an app by adding a `magicPrompt` object under the `features` section:

```json
"features": {
  "magicPrompt": {
    "enabled": true,
    "model": "gpt-4o-mini",
    "prompt": "Rewrite the user input into a concise high quality prompt and respond only with the new prompt."
  }
}
```

The server reads `model` and `prompt` from the app's configuration; the browser only sends the user's input and the app id. An app with a `magicPrompt` section that leaves out `model` or `prompt` gets the app schema's defaults (`gpt-4` and a built-in "improve this prompt" instruction). The environment variables `MAGIC_PROMPT_MODEL` and `MAGIC_PROMPT_PROMPT` apply to requests without an app and to apps without a `magicPrompt` section; `MAGIC_PROMPT_MODEL` is also tried when the app's model does not exist or the caller may not use it (see the fallback chain below). If neither is set, the system uses the globally configured default model and a built-in fallback prompt of `"Improve the following prompt."`.

## API Endpoint

The feature is powered by a single endpoint:

**POST /api/magic-prompt**

Request body:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `input` | string | Yes | The raw user text to be improved. |
| `modelId` | string | No | Model to use. Overrides the app config and `MAGIC_PROMPT_MODEL`. Must be a model the caller may use. |
| `appId` | string | No | The app whose `features.magicPrompt` settings apply, also used for usage tracking. Must be an app the caller may use. Defaults to `"direct"` (platform defaults). |

The instruction always comes from the app configuration (or `MAGIC_PROMPT_PROMPT`); a `prompt` field in the request body is ignored.

Response body:

```json
{
  "prompt": "Provide a detailed step-by-step explanation of how transformer neural networks process input tokens, including attention mechanisms and positional encoding."
}
```

The endpoint requires authentication (`authRequired` middleware). Unauthenticated requests receive a `401` response when anonymous access is disabled; otherwise the anonymous group's permissions apply.

- An unknown `appId`, or one the caller may not use, is answered with `404`.
- A `modelId` the caller may not use is answered with `403`.

## Model Fallback Chain

When determining which model to call, the server follows a fallback chain. Only models the caller may use (`permissions.models` of their groups) are considered at every level:

1. **`modelId` from the request body** — highest priority, used if provided and the model exists.
2. **The app's `features.magicPrompt.model`** — used if no model was requested or the requested one does not exist.
3. **`MAGIC_PROMPT_MODEL` environment variable**.
4. **Globally configured default model** — the model marked as `default` in `configCache.getModels()`.
5. **First available model** — as a last resort, the first model returned by `configCache.getModels()`.

If the caller may use none of them, the request is answered with `403`.

## Token Limit

All magic prompt requests use a fixed `maxTokens` of **8192**. This is intentionally generous to allow the LLM to produce a complete, well-formed improved prompt without truncation.

## Usage Tracking

Every successful magic prompt generation is recorded via `recordMagicPrompt()`. The tracked data includes:

- User session ID (from `x-session-id` header)
- App ID
- Model ID used
- Input token count (from the LLM usage report, or estimated if not available)
- Output token count (from the LLM usage report, or estimated if not available)
- User object (for attribution in multi-tenant setups)

This data feeds into the platform's usage dashboard visible in the admin panel.

## Rate Limiting

Magic prompt requests are subject to the same rate limiting rules as all other API endpoints. If the user's rate limit is exceeded, the server returns a `429 Too Many Requests` response. No special rate limit tier is applied to magic prompt requests by default.

## Usage in the Chat Interface

When enabled, a sparkles icon appears next to the chat input. Clicking it triggers the generation and the button shows a spinning animation while the request is processed. Once the text has been replaced, the sparkles button turns into a back arrow allowing the user to restore the original input. Submitting the message automatically resets the button back to the sparkles icon for the next prompt.

## Environment Variables

| Variable | Description |
| -------- | ----------- |
| `MAGIC_PROMPT_MODEL` | Default model ID used when no model is specified in the app config or request body. |
| `MAGIC_PROMPT_PROMPT` | Default system instruction used when no prompt is specified in the app config or request body. |
