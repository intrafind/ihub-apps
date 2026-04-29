# Browser Extension

The iHub Apps **browser extension** lets a signed-in user pipe the content of
the **current tab** into any of their iHub apps — summarize, translate, draft
a reply, ask a question grounded in the page — without leaving the page. It
is the web-page analogue of the [Outlook add-in](outlook-add-in.md): same
OAuth flow, same `/api/chat` pipeline, different host.

> This page covers the **side-panel browser extension** that the user
> installs in Chrome / Edge / Firefox. For the read-only Outlook task pane,
> see [Outlook Add-in Rollout](outlook-add-in.md). The two integrations are
> independent and can be enabled separately.

---

## What gets deployed

When the integration is enabled, iHub Apps exposes the following endpoints on
your deployment:

| Endpoint                                            | Purpose                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET  /api/integrations/browser-extension/config`   | Public runtime config (base URL, OAuth client ID, display name, starter prompts) the extension fetches before sign-in |
| `GET  /api/admin/browser-extension/status`          | Admin: read current configuration                                              |
| `POST /api/admin/browser-extension/enable`          | Admin: enable the integration and auto-create the OAuth client                  |
| `POST /api/admin/browser-extension/disable`         | Admin: disable                                                                 |
| `PUT  /api/admin/browser-extension/config`          | Admin: update display name, description, starter prompts, extension IDs, allowed groups |

All public routes are gated behind the `integrations` feature flag and the
`browserExtension.enabled` setting — both must be on.

The extension itself ships in this repository under `browser-extension/`. It
does **not** live on the iHub server — admins distribute it to users out of
band (see [Step 5](#step-5--distribute-the-extension)).

---

## Architecture in 30 seconds

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ Browser tab (any URL)    │ msg →  │ Extension service worker │
│  ─ extracts DOM text     │        │  ─ OAuth/PKCE flow       │
│    on demand only        │ ← msg  │  ─ token storage         │
└──────────────────────────┘        │  ─ /api/chat streaming   │
┌──────────────────────────┐        │  ─ /api/apps fetch       │
│ Side panel (React-free   │ ←/→    └────────────┬─────────────┘
│  vanilla JS)             │ chrome.runtime port │
└──────────────────────────┘                     ▼
                                       ┌──────────────────────┐
                                       │ iHub server          │
                                       │  /api/oauth/authorize│
                                       │  /api/oauth/token    │
                                       │  /api/chat (SSE)     │
                                       │  /api/apps           │
                                       │  /api/integrations/  │
                                       │    browser-extension/│
                                       │    config            │
                                       └──────────────────────┘
```

- **Tokens never leave the service worker.** The side panel and content
  script always go through the worker via `chrome.runtime` messages. Refresh
  tokens live in `chrome.storage.local`; access tokens live in
  `chrome.storage.session` and are cleared on browser restart.
- **Page content is sent only on explicit user action.** No background
  scraping, no telemetry. The content script is injected on demand via
  `activeTab` + `chrome.scripting.executeScript` only when the user clicks.

---

## Prerequisites

Before starting the rollout, confirm:

1. **Public HTTPS URL.** `chrome.identity.launchWebAuthFlow` requires the
   authorize endpoint to be HTTPS in production. (Local dev over `http://`
   on `localhost` works.)
2. **Reverse-proxy headers.** The OAuth redirect URI and config URL are
   derived from the incoming request. Make sure `X-Forwarded-Proto` and
   `X-Forwarded-Host` are forwarded correctly. See
   [Production Reverse Proxy Guide](production-reverse-proxy-guide.md).
3. **A working iHub authentication backend.** The extension does not bring
   its own user identity — it logs users in via iHub's OAuth Authorization
   Code flow. Confirm regular browser sign-in works first.
4. **`integrations` feature flag.** Same flag the Outlook add-in uses —
   without it, all browser-extension routes return 404.
5. **Browser support.** Chrome 114+, Edge 114+, or Firefox 128+ (with
   `sidePanel` MV3 support). Older Firefox versions can run a popup
   fallback in a future release.

---

## Step 1 — Enable the `integrations` feature flag

In **Admin → Platform Settings**, or directly in `contents/config/platform.json`:

```json
{
  "features": {
    "integrations": true
  }
}
```

Save and (if you edited the file directly) restart the server.

---

## Step 2 — Enable the browser-extension integration

1. Sign in to iHub Apps as an administrator.
2. Open **Admin → Browser Extension** (`/admin/browser-extension`).
3. Click **Enable**.

This single action does the following automatically — no manual
`platform.json` editing required:

- Creates a new **OAuth public client** named *Browser Extension* with PKCE,
  the `authorization_code` and `refresh_token` grants, scopes
  `openid profile email`, and `trusted: true` so PKCE clients skip the
  consent screen.
- Pins the client to the new built-in **`browser-extension` group** via the
  `allowedGroups` allowlist (see [Step 4](#step-4--decide-who-can-use-it)).
- Turns on `oauth.enabled.authz`, `oauth.enabled.clients`,
  `oauth.authorizationCodeEnabled`, and `oauth.refreshTokenEnabled` in
  `platform.json`.
- Sets `browserExtension.enabled = true` and stores the new `oauthClientId`.

After enabling, the page shows the OAuth client ID with a link to
**View OAuth Client** where you can audit or restrict it further.

> If you ever rotate or delete this client manually, click **Disable** then
> **Enable** again to recreate it. The system is idempotent — it only
> creates a new client when `oauthClientId` is empty.

---

## Step 3 — Register the extension's redirect URIs

Each browser instance assigns the extension a unique ID, and that ID is
baked into the OAuth redirect URI:

- Chrome / Edge: `https://<extension-id>.chromiumapp.org/cb`
- Firefox: `https://<extension-id>.extensions.allizom.org/cb`

You don't know the extension ID until you have loaded the extension at
least once. The flow is:

1. Load the extension into your own browser following
   [Step 5](#step-5--distribute-the-extension).
2. Note the extension ID Chrome assigns (visible at `chrome://extensions`).
3. Back in **Admin → Browser Extension**, paste the ID into the
   **Extension IDs** box (one per line) and click **Save**.
4. The server derives both redirect URIs and writes them onto the OAuth
   client's allowlist. **No secret rotation is needed.**

You can register multiple extension IDs — useful if you ship a packaged
production version and a dev-mode unpacked version, or if you maintain
separate Firefox / Chrome builds.

> **Why this matters.** OAuth requires an exact-match redirect URI. If the
> extension ID is not registered, sign-in fails with
> `invalid_request: redirect_uri not registered for this client`. Adding the
> ID here is the single setup step most easily missed.

---

## Step 4 — Decide who can use it

The migration adds a new built-in group called **`browser-extension`**
(display name *Browser Extension Users*) that inherits from `users`. The
admin page's **Allowed Groups** field lists this group by default.

How the allowlist works:

- During sign-in, the OAuth authorize endpoint checks whether the user is
  a member of any group in `client.allowedGroups`.
- If yes → the flow continues (PKCE → token exchange → tokens stored in
  the extension).
- If no → the user sees a clear *"This account is not enabled for Browser
  Extension"* page and must contact their administrator.

Two common policies:

| Policy                                                      | How to set up                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Opt-in** (recommended). Only users you add explicitly can sign in. | Leave **Allowed Groups** = `browser-extension` and add eligible users to that group via **Admin → Groups** (or external IdP mappings). |
| **Open to all employees.** Anyone in the existing `users` group can sign in. | Replace **Allowed Groups** with `users`. (Or leave it empty to skip the check entirely — *not* recommended.) |

You can mix and match: the field is a comma-separated list of internal
group IDs, e.g. `browser-extension, beta-testers, admins`.

---

## Step 5 — Distribute the extension

The extension is unsigned and not in the public Chrome Web Store yet, so
distribution is currently **side-loading** or **enterprise policy**.

### Option A — Side-load for testing

Each developer or pilot user does this once:

1. Pull the iHub Apps repository (or copy the `browser-extension/` folder).
2. Visit `chrome://extensions` (Edge: `edge://extensions`) and toggle
   **Developer mode** on.
3. Click **Load unpacked** and select the `browser-extension/` folder.
4. Copy the **ID** Chrome assigns and add it to the iHub admin page (Step 3).
5. Click the iHub icon in the toolbar to open the side panel; the gear
   button opens **Settings** where the user enters their iHub base URL
   and clicks **Sign in**.

### Option B — Enterprise policy

For organization-wide rollout on managed devices:

- Package the `browser-extension/` folder as a `.crx` (Chrome / Edge) or
  signed `.xpi` (Firefox).
- Host the package on an internal HTTPS URL.
- Use Chrome / Edge / Firefox enterprise policy
  (`ExtensionInstallForcelist` or equivalent) to push the extension to
  managed devices.
- Use a **single fixed extension ID** (set the `key` field in
  `manifest.json` after packaging) so only one ID needs to be registered
  on the iHub admin page.

Detailed packaging steps are out of scope for this guide — see your
browser vendor's enterprise documentation.

---

## Step 6 — Customize the experience

On the **Browser Extension** admin page you can also configure:

- **Display Name** — shown in the side-panel header. Localized
  (`en`, `de`, …); required, max 250 chars per locale.
- **Description** — appears on the public runtime-config endpoint and may
  be surfaced by future UI. Max 250 chars per locale.
- **Default Starter Prompts** — up to 20 quick-action prompts shown in
  the side panel when the user-selected app declares no starter prompts
  of its own. Each has a **Title** (button label, max 250 chars) and a
  **Message** (the prompt sent on click, max 4000 chars). Both fields are
  per-locale objects. Prompts can be reordered.

Click **Save**. The extension reads the new config the next time it is
opened, and the next time it fetches `/api/integrations/browser-extension/config`.

---

## How the extension uses page content

When the user clicks **Send page** (or **Send selection**, or types a
question with **Attach page content** ticked), the side panel asks the
service worker to extract text from the active tab and ships it to
`/api/chat/{appId}` as a `fileData` attachment — exactly the same shape
the Outlook add-in already uses:

```json
{
  "fileData": [
    {
      "source": "web_page",
      "fileName": "summary-of-the-article.md",
      "fileType": "text/markdown",
      "displayType": "text/markdown",
      "content": "# Article title\n\nSource: https://...\n\n<full article text>"
    }
  ]
}
```

This means **no server-side changes were required for ingesting page
content** — the existing chat pipeline knows how to attach `fileData` to
a user message.

The extractor:

- Caps text at 200,000 characters.
- Selection-only mode wins if the user has selected text on the page.
- Otherwise picks the largest of `<article>` / `<main>` / `<body>`,
  stripping `<script>`, `<style>`, `<nav>`, `<footer>`, `<aside>`,
  `<header>`, `<form>`, and `<iframe>` before reading text.
- Skips Chromium internal pages (`chrome://`, `edge://`, `about:`,
  `chrome-extension:`).

To upgrade to Mozilla Readability later, vendor
`@mozilla/readability/Readability.js` next to `background.js` and replace
the `extractPageInPage` function — see `browser-extension/README.md`.

---

## Privacy & security model

- **Tokens never leave the service worker.** Content scripts and the side
  panel get tokens *only* indirectly via message-passed API calls.
- **Page content is sent to the iHub server only on explicit user action.**
  No telemetry, no background scrape.
- **No host permissions at install time.** The extension uses
  `activeTab` + on-demand `chrome.scripting.executeScript`, so it only
  touches a page when the user clicks. The user grants per-site access via
  the `optional_host_permissions` flow if needed.
- **Self-hosted iHub URL.** The extension stores the user-entered base
  URL and rejects anything that does not begin with `http://` or
  `https://` before issuing any request.
- **Refresh token** lives in `chrome.storage.local` (encrypted at rest by
  the OS keychain on Chrome 122+). Access token in
  `chrome.storage.session` (cleared on browser restart).
- **Group allowlist.** A user not in any `allowedGroups` group is rejected
  at the OAuth authorize step with a clear access-denied page; the
  decision endpoint re-checks on POST so revoked group membership during
  the consent flow is honoured.

---

## Troubleshooting

### `invalid_request: redirect_uri not registered for this client`

The extension ID has not been added to **Admin → Browser Extension →
Extension IDs**. Note the ID from `chrome://extensions`, paste it in,
click **Save**, and try **Sign in** again.

### `404 Browser extension integration is not enabled`

Either the `integrations` feature flag is off (Step 1), or you haven't
clicked **Enable** on the admin page (Step 2). Check
`contents/config/platform.json` — `features.integrations` and
`browserExtension.enabled` must both be `true`.

### Sign-in window opens, user authenticates, but page shows *"This account is not enabled for Browser Extension"*

The user is authenticated against iHub but is not in any group listed in
**Allowed Groups**. Add them to the `browser-extension` group via
**Admin → Groups**, or update the group mappings on your external IdP.

### Side panel shows *"Failed to load apps"*

Either:

- The user's session expired and the refresh token was rejected. Click
  the sign-out icon in the side-panel header and sign in again.
- The OAuth client was deleted or rotated outside the admin UI. Click
  **Disable** then **Enable** on the admin page to recreate it.

### Extension can read most pages but says *"This tab type isn't supported"*

The current tab is a Chromium internal page (`chrome://`, `edge://`,
`about:`, `chrome-extension:`). The extension intentionally refuses to
inject into those for security reasons. Switch to a regular `https://`
tab and retry.

### Tokens persist after `Sign out`

Sign-out clears `chrome.storage.session` (access token) and removes the
refresh token from `chrome.storage.local`, but it does **not** revoke the
underlying iHub session cookie or the OAuth client's grants. To fully
revoke a user, disable their iHub account or remove them from the
allowed group — the next refresh attempt will fail.

---

## Roadmap

What is **not** in this release (Phase 1):

- **Page automation / agentic actions.** No clicking, typing,
  form-filling, or DOM mutation. Reading is read-only.
- **Background or idle scraping.** The extension only reads the page when
  the user explicitly opens it and triggers an action.
- **Cross-tab orchestration.** Single active tab per request.
- **PDFs in tab.** The Chromium PDF viewer is special and is intentionally
  marked unsupported in MVP.
- **Firefox sign-in via popup.** The extension uses the side panel, which
  Firefox supports from version 128 onward. Older Firefox builds will get
  a popup fallback in Phase 2.
- **Selling per-extension API keys.** No separate billing/quotas; auth and
  quotas piggyback on the user's iHub session.

Phase 3 (separate design doc required): authorized actions — letting the
extension type into the active tab on user confirmation
(e.g. "insert this draft reply into the Gmail compose box").

See `concepts/browser-extension/2026-04-28 Browser Extension Plan.md`
for the full design.
