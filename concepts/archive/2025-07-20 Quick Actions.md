# Quick Actions

## Overview

This concept outlines how the system can offer quick action suggestions returned by the LLM. The frontend will display these suggestions so users can select an option rather than type a response.

## Goals

- Streamline user interaction with common follow-up actions.
- Encourage structured, low-friction workflows in apps that support decision flows.
- Keep backwards compatibility with existing APIs and message formats.

## Design

### Server

1. **Schema Changes**
   - Extend the chat message schema to include an optional `actions` array. Each action has `id`, `label`, and an optional `payload`.
2. **LLM Instructions**
   - Apps can define a list of possible actions in their configuration. The server injects these into the system prompt and requests the model to respond with a JSON object containing `actions` along with the normal reply.
3. **Adapters**
   - Adapt each model provider to support returning JSON with action suggestions. Reuse the Structured Output feature to enforce this format.

### Client

1. **UI Rendering**
   - When a chat message includes `actions`, render them as clickable buttons below the assistant's response.
   - Selecting an action sends the associated payload (or label) as the next user message.
2. **Internationalization**
   - Use `shared/i18n` translations for button labels.

## Implementation Steps

1. Update `shared/unifiedEventSchema.js` to add the optional `actions` property.
2. Modify `server/services/chatService.js` to parse action suggestions from the model response.
3. Extend the React chat component in `client` to render buttons for actions.
4. Document the configuration in `docs` and provide examples in `examples`.

## Open Questions

- How many actions should be suggested at once?
- Should the model also provide a short description for each action?
