# Notification Center (Preview)

A per-user, real-time notification bell that surfaces background job
completion (and future event types) even if the user has navigated away
from the tab that started the job.

> **Status:** Preview feature, disabled by default (`features.notifications`).
> Enable it under **Admin → Platform → Features** to try it out.

## Why

Background jobs (e.g. AI OCR via the Tools Service) only reported progress
to a client that had an **open** `/jobs/:jobId/progress` SSE connection at
the moment the job finished — closing the tab or navigating away silently
lost the completion event. The notification center adds a small, durable
record of terminal job events (`completed` / `error` / `cancelled`) that
survives across page loads and multiple open tabs.

## Scope (v1)

This is intentionally a small, self-contained slice, not the full design
sketched in the original feature request:

- **Producer:** only background-job lifecycle events
  (`job.completed` / `job.error` / `job.cancelled`), emitted once per job
  from `server/routes/toolsService/jobStore.js`. Intermediate progress
  ticks are **not** persisted as notifications — they're too frequent
  (e.g. one per OCR page) to be useful in a notification list.
- **Storage:** one JSON file per user under
  `contents/data/notifications/<userId>.json`, capped at the 200 most
  recent entries. This is **not** backed by PostgreSQL — durable,
  multi-instance-safe storage is tracked separately (see
  [`concepts/`](../concepts) for the PostgreSQL persistence work) and can
  replace this store later without changing `NotificationService`'s API.
- **Delivery:** a dedicated per-user SSE channel
  (`GET /api/notifications/stream`, multiple tabs per user supported) plus
  a REST list/mark-read API, so a client that missed the live push still
  sees the notification on next load.
- **UI:** a bell icon in the header (visible to authenticated users only)
  with an unread-count badge and a dropdown panel. No toast/desktop
  notifications and no admin-broadcast ("system announcement") producer
  in this first slice.

## Server

| Endpoint | Description |
| --- | --- |
| `GET /api/notifications/stream` | SSE stream of new notifications for the authenticated user |
| `GET /api/notifications` | List persisted notifications (`?limit=`, `?unreadOnly=true`) |
| `POST /api/notifications/:id/read` | Mark one notification read |
| `POST /api/notifications/read-all` | Mark all of a user's notifications read |

Key modules:

- `server/services/notifications/NotificationService.js` — in-process
  event bus (`notify(userId, type, data)`); persists then broadcasts.
- `server/services/notifications/NotificationStore.js` — per-user
  JSON-file persistence.
- `server/routes/notifications.js` — the four endpoints above, gated
  behind `requireFeature('notifications')`.

## Client

- `client/src/features/notifications/hooks/useNotifications.js` — loads
  the initial list via REST, then subscribes to the SSE stream.
- `client/src/features/notifications/components/NotificationBell.jsx` /
  `NotificationPanel.jsx` — header bell + dropdown, mounted in
  `Layout.jsx` when the feature flag is enabled and the user is
  authenticated.

## Enabling

1. Admin → Platform → Features → enable **Notifications**.
2. Reload the app — authenticated users now see a bell icon in the
   header.
