# Request Throttling

## Overview
External LLM providers and web tools enforce rate limits. To avoid hitting those limits when multiple requests are made concurrently, a simple queue based throttling mechanism has been introduced.

## Key Files
- `server/requestThrottler.js` – implements `throttledFetch` with per-model and per-tool queues.
- `contents/config/platform.json` – defines the default `requestConcurrency` value.
- `contents/config/models.json` / `tools.json` – optional `concurrency` values overriding the default.
- LLM service and tool modules now use `throttledFetch` instead of `fetch`.

## Usage
Specify `requestConcurrency` in `platform.json` to limit concurrent outbound requests. A value below `1` or an omitted setting means concurrency is unlimited. Individual models or tools can define a `concurrency` property to override the global value with the same rules. All outbound fetch calls from chat services and tools now use `throttledFetch(modelId|toolId, url)`.
