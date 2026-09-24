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

## Usage Reports: Prompt-Cache Metrics

Admins can now see how much of the model input the providers serve from their prompt cache.
Cached input is billed at a steep discount and answers faster, so this shows where caching already
saves money and where it doesn't. The new **Prompt caching** panel on **Admin → Usage Reports**
shows the cache hit ratio, cached input tokens and cache write tokens, with a breakdown by model,
app and provider.

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
- Only usage recorded after the upgrade has cache counts. iHub does not ask providers to cache yet,
  so the numbers show what they cache on their own.
