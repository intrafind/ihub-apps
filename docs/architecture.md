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

## Shared
- `shared/` – Code used by both client and server, such as localization helpers.

This structure helps new developers quickly locate features and shared utilities.
