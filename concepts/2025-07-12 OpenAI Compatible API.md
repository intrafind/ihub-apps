# OpenAI-Compatible API Gateway

## Summary

This concept describes a new API gateway that exposes multiple model providers through a single interface compatible with OpenAI's API. The goal is to allow applications to interact with Gemini, OpenAI, Mistral, and Anthropic models using the familiar OpenAI chat completions format. The gateway will support tool calls, structured outputs, image inputs/outputs, optional audio support, and both streaming and non-streaming responses.

## Goals

- **Unified Interface:** Provide a drop-in replacement for OpenAI's `/chat/completions` endpoint.
- **Model Translation:** Translate requests and responses to/from Gemini, Mistral, and Anthropic APIs.
- **Rich Media Support:** Handle text, image, and eventually audio prompts with streaming options.
- **Tool Integrations:** Allow tool usage and structured function calls across providers.

## Key Features

1. **Request Normalization**
   - Accept OpenAI-compatible payloads and normalize parameters (model name, temperature, tools, etc.).
   - Validate incoming tools and schema for structured outputs.

2. **Provider Translation**
   - Map normalized requests to the corresponding provider API.
   - Implement adapters for Gemini, OpenAI, Mistral, and Anthropic.
   - Support provider-specific options through configuration.

3. **Streaming and Non-Streaming**
   - Provide SSE/WebSocket streaming similar to OpenAI.
   - Fallback to standard JSON responses for non-streaming.

4. **Image and Audio Handling**
   - Accept image data in OpenAI format for providers that support vision models.
   - Reserve a compatible field for future audio input/output.

5. **Tool and Structured Output Support**
   - Parse `function_call`/`tool_call` sections and route them to the underlying provider.
   - Normalize tool responses for consistent output across models.

## Implementation Notes

- Begin with Gemini and OpenAI adapters; add Mistral and Anthropic once stable.
- Use environment-based configuration to select the provider and manage API keys.
- Leverage caching in `server/configCache.js` to minimize repeated configuration loads.
- Maintain translation keys for user-facing errors in `locales/en.json` and `locales/de.json`.
- Document configuration options in `docs/` as the feature evolves.

## Future Work

- Extend the gateway to handle audio conversations when providers expose stable endpoints.
- Expose analytics to track usage per provider and error rates.

## Existing Implementation Overview

- The project is organized as a Node.js backend in `server/`, a React client in `client/`, and shared libraries under `shared/`.
- `server/adapters/` already contains adapters for OpenAI, Google (Gemini), Anthropic and Mistral models.
- `server/services/chatService.js` prepares requests, handles tool calls, and manages streaming or non-streaming responses via these adapters.
- Current chat endpoints are available only under `/api/apps/:appId/chat/:chatId` and related paths.

## Gateway Integration Plan

1. Introduce a new public route `/v1/chat/completions` that accepts OpenAI-style payloads.
2. Normalize and translate requests using helper functions from `server/adapters/index.js`.
3. Dispatch to the correct provider and stream results by reusing `executeStreamingResponse` or `executeNonStreamingResponse` from `chatService.js`.
4. Validate incoming tool definitions and execute tool calls using existing `processChatWithTools` logic.
5. Load API keys and provider mappings via `configCache` and document configuration options.
