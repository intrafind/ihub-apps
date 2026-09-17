# Nextcloud Embed — concept docs

This folder collects the design docs for the "chat from inside Nextcloud"
flow added in response to [issue
#1401](https://github.com/intrafind/ihub-apps/issues/1401). The picker
flow (chat about Nextcloud files initiated from inside iHub) shipped in
#1400; this embed is the complementary surface, initiated from inside
Nextcloud.

## Documents

- [Nextcloud Embed UI (design)](./2026-05-11%20Nextcloud%20Embed%20UI.md)
- [PostMessage / Hash Selection Protocol](./2026-05-11%20PostMessage%20%2F%20Hash%20Selection%20Protocol.md)

## TL;DR

- Reuse the embedded host adapter pattern from
  `client/src/features/office/` — Outlook and the browser extension
  already use the same contract.
- Reuse the existing `NextcloudService` and `/api/integrations/nextcloud/*`
  endpoints (especially `/download`) for all file access — the embed adds
  zero new Nextcloud-server-side code.
- Pass the file selection from Nextcloud to iHub via a URL hash on
  initial navigation, plus `postMessage` for ongoing updates. The iHub
  side validates `event.origin` against admin-configured
  `allowedHostOrigins`.
- iHub authentication is its own OAuth2 + PKCE flow (auto-created by the
  admin "Enable" toggle); the user OAuth-links Nextcloud-to-iHub once
  via the existing picker flow and the same grant powers the embed.
- The Nextcloud-side app is shipped as a scaffold in `nextcloud-app/`
  — minimum viable, not App Store polish.
