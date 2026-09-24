# Features — Unreleased

## Uploads: Teams Transcripts (.vtt) and Any Text File

Users can now attach WebVTT files (`.vtt`) — the format Microsoft Teams exports meeting transcripts
in — to chats in any app that accepts plain text files. Admins can also allow "Any text file" for
an app, so logs, YAML, subtitle files and other plain-text formats can be uploaded without listing
each one.

- Existing apps that accept `.txt` accept `.vtt` automatically after the upgrade.
- "Any text file" is off by default. Enable it under **Admin → Apps → Upload → Supported File
  Formats**. The file picker then shows all files; binary files are rejected on upload, and formats
  such as PDF or Word are only extracted when they are selected explicitly.

## Prompt Caching: Per-Model Switch and Cache Metrics

Providers serve the start of a prompt they have seen recently from a cache, billed at a steep
discount and answered faster. Admins can now switch prompt caching on or off per model and see how
much input the cache serves. The switch is under **Admin → Models → Prompt Caching** for OpenAI,
Anthropic and Bedrock models. The new **Prompt caching** panel on **Admin → Usage Reports** shows
the cache hit ratio, cached input tokens and cache write tokens, with a breakdown by model, app and
provider.

- **Defaults:** on for OpenAI models on `api.openai.com`, which cache automatically — the switch
  adds a cache key per app that raises the hit rate. Off for Anthropic and Bedrock, where writing
  to the cache costs 25 % more than normal input, and for OpenAI-compatible servers, which may
  reject the parameter. Other providers cache on their own and have no switch.
- The shipped platform context and the iAssistant and iFinder search apps now tell the model the
  date only, no longer the user's timezone. The timezone differed per user, so every prompt
  started differently and could not be cached. Texts an admin has changed are left as they are;
  the `{{timezone}}` and `{{time}}` variables keep working.
- **Timeline** adds cached vs. uncached input tokens over time, cache columns in the app and model
  breakdowns, and a new **Providers** breakdown.
- Cache writes are shown next to reads: when a model writes to the cache more than it reads from
  it, the tile turns amber. On Anthropic and Bedrock, where writes cost extra, caching then costs
  more than it saves.
- Captured for Anthropic, Bedrock, OpenAI (Chat Completions and Responses), Google Gemini, Mistral
  and vLLM, together with reasoning tokens where the provider reports them.
- The event CSV export has new columns after the existing ones: `provider`, `cacheReadTokens`,
  `cacheWriteTokens`, `reasoningTokens`, `webSearchRequests`. OpenTelemetry spans carry the
  cache counts as `gen_ai.usage.cache_read.input_tokens` and
  `gen_ai.usage.cache_creation.input_tokens`.
- Only usage recorded after the upgrade has cache counts.
