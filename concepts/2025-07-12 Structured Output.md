# Structured Output

This concept documents how apps can enforce structured JSON responses from language models.

## Overview

Apps may define an `outputSchema` property containing a JSON Schema. When present, the server instructs the LLM to respond in valid JSON matching this schema and enables the provider's JSON mode if available.

## Implementation Details

- `outputSchema` is optional in each app configuration. The schema is stored verbatim and passed to the adapter.
- `processMessageTemplates` injects system instructions to reply only with JSON and references the schema when defined.
- `chatService.prepareChatRequest` forwards `responseFormat` and `responseSchema` options to the selected model adapter.
- Adapters translate these options to provider specific parameters:
  - **OpenAI/Mistral** use `response_format: { type: 'json_object' }` when JSON output is requested.
  - **Anthropic** uses `response_format: { type: 'json_object' }`.
  - **Google Gemini** sets `generationConfig.responseMimeType` to `application/json` and passes the schema via `generationConfig.responseSchema`.

This ensures consistent structured responses across supported models.
