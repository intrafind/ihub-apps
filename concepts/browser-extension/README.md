# iHub Browser Extension

This folder collects design and planning documents for the **iHub Apps browser
extension** — a companion that lets users send the content of any web page to
their iHub apps the same way the Outlook add-in lets them send the content of
an email.

## Documents

- [`2026-04-28 Browser Extension Plan.md`](./2026-04-28%20Browser%20Extension%20Plan.md) —
  initial concept, scope, architecture, reuse strategy, and phased rollout
  plan. Start here.
- [`2026-11-17 Local Browser Bridge.md`](./2026-11-17%20Local%20Browser%20Bridge.md) —
  idea: let the cloud agent act in the user's own browser through the
  extension ("device tools"). The design doc for the plan's Phase 3.

## Status

The read-only Phase 1 extension exists in `browser-extension/`; the local
browser bridge is an idea without code. The plan reuses the Outlook add-in's
OAuth 2.0 + PKCE flow, group-based permissions, and chat-message construction
patterns; new work is mostly the extension shell (Manifest V3) and the page
content extractor.

## Relationship to existing integrations

| Integration         | Surface                  | Auth            | Group              |
| ------------------- | ------------------------ | --------------- | ------------------ |
| Outlook add-in      | Office.js taskpane       | OAuth + PKCE    | `users` (default)  |
| Office 365 (files)  | iHub web UI source picker| OAuth (per-user)| `users` (default)  |
| **Browser ext.**    | Browser side panel/popup | OAuth + PKCE    | new `extension`    |

The browser extension is conceptually closest to the Outlook add-in: it is a
client-side surface that obtains user-scoped access to iHub via PKCE and uses
the existing `/api/chat` endpoint with `fileData`/`imageData` rather than a new
server-side OAuth integration.
