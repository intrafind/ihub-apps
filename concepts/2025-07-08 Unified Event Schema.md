# Unified Event Schema

## Overview
Defines a standard set of Server-Sent Events (SSE) used by the server and client
for all chat and tool interactions. The schema provides a consistent lifecycle
from the initial session start to the final completion, including progress
updates from tools.

## Key Files
- `shared/unifiedEventSchema.js` – exports the event name constants.
- `server/actionTracker.js` – emits events using the unified schema.

## Event List
- `connected` – SSE connection established.
- `error` – generic error information.
- `done` – the entire interaction has completed.
- `session.start` – a new chat session begins.
- `session.end` – the session is finished.
- `chunk` – streamed text from the LLM.
- `tool.call.start` – a tool invocation has begun.
- `tool.call.progress` – optional progress for long running tools.
- `tool.call.end` – tool invocation finished.
- `citation` – marks text supported by a citation.
- `safety.warning` – potential safety issue detected.

These events are extensible and allow the frontend to provide rich feedback
about the LLM’s reasoning steps and tool activity.
