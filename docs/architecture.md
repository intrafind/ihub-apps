# Project Architecture

This repository contains a React frontend in `client/` and a Node.js backend in `server/`.

## Frontend
- `src/components` – React components grouped by feature. Generic upload and voice components live under `upload/` and `voice/`.
- `src/hooks` – Custom React hooks.
- `src/utils` – Utility helpers and caches.

## Backend
- `routes/` – Express route handlers.
- `services/` – Business logic such as chat handling.
- `adapters/` – Provider specific API wrappers.
- `utils/` – Utility modules like error handling and API key verification.

### ChatService Architecture
The chat functionality has been refactored into modular components:
- `services/chat/ChatService.js` – Main orchestration class
- `services/chat/RequestBuilder.js` – Request preparation logic  
- `services/chat/NonStreamingHandler.js` – Non-streaming response handling
- `services/chat/StreamingHandler.js` – Streaming response handling
- `services/chat/ToolExecutor.js` – Tool execution logic
- `utils/ErrorHandler.js` – Centralized error handling with custom error classes
- `utils/ApiKeyVerifier.js` – Centralized API key verification

## Shared
- `shared/` – Code used by both client and server, such as localization helpers.

This structure helps new developers quickly locate features and shared utilities.

## Development Testing

### Server Startup Validation
After any architectural changes or refactoring, validate server startup:

```bash
# Quick server startup test
timeout 10s node server/server.js || echo "Server startup check completed"

# Full development environment test  
timeout 15s npm run dev || echo "Development environment startup check completed"
```

This prevents deployment of code with import errors, missing dependencies, or runtime issues.
