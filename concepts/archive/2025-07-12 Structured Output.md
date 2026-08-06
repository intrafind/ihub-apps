# Structured Output

This concept documents how apps can enforce structured JSON responses from language models.

## Overview

Apps may define an `outputSchema` property containing a JSON Schema. When present, the server instructs the LLM to respond in valid JSON matching this schema and enables the provider's JSON mode if available.

## Implementation Details

- `outputSchema` is optional in each app configuration. The schema is stored verbatim and passed to the adapter.
- `processMessageTemplates` injects system instructions to reply only with JSON and references the schema when defined.
- `chatService.prepareChatRequest` forwards `responseFormat` and `responseSchema` options to the selected model adapter.
- Adapters translate these options to provider specific parameters:
  - **OpenAI** uses `response_format: { type: 'json_object' }` when JSON output is requested.
  - **Mistral** uses `response_format: { type: 'json_schema', json_schema: { schema, name: 'response', strict: true } }` when a schema is provided (falling back to `json_object` without a schema).
  - **Anthropic** adds a `json` tool with the schema and sets `tool_choice` so the model responds through this tool.
  - **Google Gemini** sets `generationConfig.response_mime_type` to `application/json` and passes the schema via `generationConfig.response_schema`.

This ensures consistent structured responses across supported models.
