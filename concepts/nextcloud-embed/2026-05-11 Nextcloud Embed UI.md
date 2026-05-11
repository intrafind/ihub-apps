# Nextcloud Embed UI — design

## Problem

Users want to start a chat in iHub from inside Nextcloud: pick one or
more documents in Nextcloud Files, click an action, and land in an
embedded iHub chat with those documents already attached. The user
journey should mirror the existing Outlook add-in (chat about the
current email) and browser extension (chat about the active tab).

Issue: [#1401](https://github.com/intrafind/ihub-apps/issues/1401).
Counterpart that already shipped: [#1400](https://github.com/intrafind/ihub-apps/issues/1400)
("Nextcloud as a cloud storage provider") — the picker flow, where iHub
reaches into Nextcloud.

## Constraints

- Reuse, do not rebuild, the cloud-storage Nextcloud server stack from
  #1400 (`NextcloudService`, `/api/integrations/nextcloud/*`,
  encrypted per-user token storage).
- Reuse the existing embedded host adapter pattern in
  `client/src/features/office/` — Outlook and the browser extension
  share the same `OfficeApp` shell + `EmbeddedHostContext`. The embed is
  the third host.
- No new Nextcloud token surface. The embed must not receive a Nextcloud
  access token from its host iframe — iHub already has an encrypted
  per-user refresh-rotated grant.
- Defence in depth: never trust the parent frame. Validate CSP
  `frame-ancestors`, `postMessage` origin, and URL-hash payloads with
  the same strictness.

## Architecture

```
┌─────────────────────────────────────────┐
│  Nextcloud (cloud.example.com)          │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ Files app + "Chat with iHub"     │   │
│  │  file action (nextcloud-app/)    │   │
│  └────────────┬─────────────────────┘   │
│               │ navigate to             │
│               │ <ihub>/nextcloud/       │
│               │ taskpane.html#paths=…   │
│               ▼                         │
└───────────────┼─────────────────────────┘
                │
                │ (iframe or new tab)
                │
┌───────────────┼─────────────────────────┐
│  iHub (ihub.example.com)                │
│  /nextcloud/taskpane.html               │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ Selection bridge (hash + msg)    │   │
│  └────────────┬─────────────────────┘   │
│               │ getCurrentSelection()   │
│               ▼                         │
│  ┌──────────────────────────────────┐   │
│  │ Document context: per-path GET   │   │
│  │ /api/integrations/nextcloud/     │   │
│  │  download?filePath=…             │   │
│  └────────────┬─────────────────────┘   │
│               │ HostMailContext         │
│               ▼                         │
│  ┌──────────────────────────────────┐   │
│  │ useOfficeChatAdapter (unchanged) │   │
│  │  → /api/apps/.../chat/...        │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Server changes

| Path | Purpose |
| --- | --- |
| `server/migrations/V038__add_nextcloud_embed_config.js` | Default `nextcloudEmbed` block + `nextcloud-embed` group |
| `server/routes/admin/nextcloudEmbed.js` | Admin status / enable / disable / config |
| `server/routes/integrations/nextcloudEmbed.js` | Public runtime config + Nextcloud `info.xml` |
| `server/routes/nextcloudEmbedPages.js` | Serves `/nextcloud/taskpane.html` with CSP `frame-ancestors` |

No new file-access code. `/api/integrations/nextcloud/download` already
serves the embed unchanged.

## Client changes

| Path | Purpose |
| --- | --- |
| `client/nextcloud/taskpane.html` | Entry HTML (no Office.js, includes a postMessage buffer) |
| `client/nextcloud/taskpane-entry.jsx` | Bootstrap: config → bridge → mount `OfficeApp` with Nextcloud host adapter |
| `client/nextcloud/nextcloud.css` | Scoped Tailwind reset |
| `client/public/nextcloud/callback.html` | iHub OAuth popup callback |
| `client/src/features/nextcloud-embed/utilities/nextcloudAuthDialog.js` | Browser-popup auth dialog |
| `client/src/features/nextcloud-embed/utilities/nextcloudSelectionBridge.js` | Hash + postMessage receiver |
| `client/src/features/nextcloud-embed/utilities/nextcloudDocumentContext.js` | Builds `HostMailContext` via `/download` |
| `client/src/features/nextcloud-embed/hooks/useNextcloudConnection.js` | "Connect Nextcloud" CTA state |
| `client/src/features/admin/pages/AdminNextcloudEmbedPage.jsx` | Admin UI |

The Vite multi-entry config picks up `client/nextcloud/taskpane.html` and
emits the bundle into `client/dist/nextcloud/`.

## Nextcloud-side scaffold

`nextcloud-app/` ships a minimum viable Nextcloud app:

- `appinfo/info.xml` + `appinfo/routes.php` — app metadata + one route.
- `lib/Controller/PageController.php` — renders the iframe host page,
  adds the iHub origin to the page's CSP `frame-src`.
- `templates/main.php` + `css/main.css` — page chrome.
- `src/main.js` — registers a "Chat with iHub" file action, opens the
  iHub embed URL in a new tab, and (on the host page) iframes it with
  hash + postMessage selection updates.
- `Makefile` — `make build` / `make package`.

Configured via `occ`:

```
occ config:app:set ihub_chat ihub_base_url --value=https://ihub.example.com
occ config:app:set ihub_chat ihub_provider_id --value=nextcloud-main
```

## Auth model

- **iHub login**: standard iHub OAuth2 + PKCE flow against the auto-
  created OAuth client (admin "Enable" creates it). The Nextcloud embed
  uses a browser popup (`window.open`) instead of the Office dialog API
  — see `nextcloudAuthDialog.js`.
- **Nextcloud access**: not the embed's concern. iHub's server uses its
  existing encrypted per-user refresh-rotated grant against the
  configured Nextcloud cloud-storage provider. First-time users see a
  "Connect Nextcloud" CTA inside the embed that hard-navigates to
  `/api/integrations/nextcloud/auth?providerId=…&returnUrl=…` and lands
  back in the embed with hash selection intact.

## Trade-offs

- We chose **reuse over duplication**: the embed has no WebDAV code of
  its own and no parallel Nextcloud auth path. The cost is that
  first-time users see two sign-in steps (iHub login → Connect
  Nextcloud). That's a one-time cost per browser; the alternative —
  host-injected access tokens — would require iHub to either ship a
  WebDAV client to the iframe or accept a Nextcloud token at its API
  layer, both meaningful surface-area additions.
- We chose **URL hash + postMessage** over a single mechanism:
  - The hash carries the initial selection through a hard navigation,
    which is required when the file action opens a new tab.
  - postMessage carries subsequent updates while the iframe is mounted.
  - Both go through the same `sanitizeSelectionPayload` to avoid the
    bridge having two divergent validation paths.
- We chose **no Nextcloud token at the embed boundary**, even though the
  user originally suggested host-injected tokens. The plan calls this
  decision out so it can be reverted easily by adding a fallback
  `Authorization: Bearer <hostToken>` path in
  `nextcloudDocumentContext.js`. Strictly additive.
