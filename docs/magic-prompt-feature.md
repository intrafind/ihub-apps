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

If `model` or `prompt` is omitted, the server falls back to the environment variables `MAGIC_PROMPT_MODEL` and `MAGIC_PROMPT_PROMPT`. If neither is set, the system uses the globally configured default model and a built-in fallback prompt of `"Improve the following prompt."`.

## API Endpoint

The feature is powered by a single endpoint:

**POST /api/magic-prompt**

Request body:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `input` | string | Yes | The raw user text to be improved. |
| `prompt` | string | No | Custom system instruction. Overrides `MAGIC_PROMPT_PROMPT` and the default. |
| `modelId` | string | No | Model to use. Overrides the app config and `MAGIC_PROMPT_MODEL`. |
| `appId` | string | No | App context for usage tracking. Defaults to `"direct"`. |

Response body:

```json
{
  "prompt": "Provide a detailed step-by-step explanation of how transformer neural networks process input tokens, including attention mechanisms and positional encoding."
}
```

The endpoint requires authentication (`authRequired` middleware). Unauthenticated requests receive a `401` response.

## 3-Level Model Fallback Chain

When determining which model to call, the server follows a three-level fallback chain:

1. **`modelId` from the request body** — highest priority, used if provided and the model exists.
2. **`MAGIC_PROMPT_MODEL` environment variable** — used if the requested model is not found or not provided.
3. **First available model** — if both of the above are unavailable, the server selects the first model returned by `configCache.getModels()`.

This ensures the feature always has a working model even in environments with restricted model availability.

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
