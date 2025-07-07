# Action Tracker

## Overview
A centralized event tracking mechanism for tools and server components. Instead of manually sending SSE events from each location, components update the shared `ActionTracker` which emits a unified `action` event. The chat session handler forwards these events to the appropriate SSE client.

## Key Files
- `server/actionTracker.js` – singleton tracker with a step counter, emitting SSE events.
- `server/routes/chat/sessionRoutes.js` – listens to tracker events and forwards them to connected clients.
- `server/tools/deepResearch.js` – example tool publishing progress via `actionTracker`.
- `server/services/chatService.js` – streams chat events through the tracker.

## Usage
1. Import `actionTracker`:
   ```javascript
   import { actionTracker } from '../actionTracker.js';
   ```
2. Emit steps using `trackAction` or `trackThink` with a `chatId` to route the event to the correct client.
3. Clients receive `action` events over SSE containing the latest step information.
