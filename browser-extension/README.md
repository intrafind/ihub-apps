# iHub Apps — Browser Extension

A Manifest V3 browser extension that lets a signed-in iHub user pipe the
content of the **current tab** into any of their iHub apps — summarize,
translate, draft a reply, ask a question grounded in the page — without
leaving the page.

This is the read-only Phase 1 MVP described in
`concepts/browser-extension/2026-04-28 Browser Extension Plan.md`. It
deliberately does no page automation, no background scraping, and no
cross-tab orchestration.

## What's in the package

```
browser-extension/
├── manifest.json        Manifest V3 manifest
├── background.js        Service worker — OAuth, token storage, API forwarding
├── sidepanel.html       Side panel root
├── sidepanel.js         Side panel UI (vanilla JS, no build step)
├── sidepanel.css        Styling
├── options.html         Settings page (set iHub base URL, sign in/out)
├── options.js
├── icons/               16/48/128 PNG icons
└── README.md            (this file)
```

The package is dependency-free. Page text is extracted with a small
self-contained reader (article / main / body fallback) executed in the
content world via `chrome.scripting.executeScript`. To upgrade to Mozilla
Readability later, vendor `@mozilla/readability/Readability.js` next to
`background.js` and replace the `extractPageInPage` function with one that
runs Readability on a `document.cloneNode(true)`.

## Server side

This extension talks to the same iHub server as the Outlook add-in. It uses
the existing OAuth 2.0 Authorization Code + PKCE flow at
`/api/oauth/authorize` and `/api/oauth/token`, plus three new server
endpoints introduced alongside the extension:

| Method | Path                                       | Purpose                                    |
| ------ | ------------------------------------------ | ------------------------------------------ |
| POST   | `/api/admin/browser-extension/enable`  | Auto-create the extension's OAuth client   |
| POST   | `/api/admin/browser-extension/disable` | Disable the integration                    |
| PUT    | `/api/admin/browser-extension/config`  | Update display + redirect + group settings |
| GET    | `/api/admin/browser-extension/status`  | Read current configuration                 |
| GET    | `/api/integrations/browser-extension/config`       | Public runtime config the extension reads  |

The OAuth client has a new optional `allowedGroups` field that pins
authentication to a specific iHub group. The default migration adds an
`extension` group that admins can populate explicitly — a user not in any
of the listed groups sees a clear access-denied page during sign-in.

## Loading the extension (Chrome / Edge)

1. Visit `chrome://extensions` (or `edge://extensions`) and enable
   **Developer mode**.
2. Click **Load unpacked** and pick the `browser-extension/` directory.
3. Note the **extension ID** Chrome assigns and copy it.
4. In iHub admin, open **Browser Extension** and:
   - Click **Enable** if you haven't already (this auto-creates the
     OAuth client).
   - Paste the extension ID into the **Extension IDs** box and **Save**.
     This registers the redirect URIs
     `https://<id>.chromiumapp.org/cb` and
     `https://<id>.extensions.allizom.org/cb` on the OAuth client.
   - Add eligible users to the **browser-extension** group (or whichever groups
     you listed under **Allowed Groups**).
5. Click the iHub icon in the toolbar to open the side panel, then
   click the gear in the side panel header to set the iHub base URL.
6. Click **Sign in**. Chrome opens a tab against
   `${baseUrl}/api/oauth/authorize`; on success the extension stores
   tokens and the side panel switches to the main view.

## Using it

- Pick an app from the dropdown. The list mirrors what you see in the
  main iHub web app — your group permissions apply.
- Click **Send page** to send the active tab's text with a
  "Summarize this page" prompt.
- Click **Send selection** to send only the currently-selected text.
- Or type a free-form question. The **Attach page content** toggle
  controls whether the page text is appended to the request as a
  `fileData` attachment (the same shape the Outlook add-in already uses).

## Privacy & security model

- **Tokens never leave the service worker.** The side panel and content
  script always go through the worker via `chrome.runtime` messages.
  Refresh tokens live in `chrome.storage.local` (encrypted at rest by
  the OS keychain on Chrome 122+); access tokens live in
  `chrome.storage.session` and are cleared on browser restart.
- **Page content is sent only on explicit user action.** No background
  scraping, no telemetry, no idle requests.
- **No host permissions at install time.** The extension uses
  `activeTab` + on-demand `scripting.executeScript`, so it only touches
  a page when the user clicks. The user grants per-site access via the
  `optional_host_permissions` flow if needed.
- **Self-hosted iHub URL.** The extension stores the user-entered base
  URL and rejects anything that doesn't begin with `http://` or
  `https://`. The runtime config endpoint is fetched without
  credentials.

## Distribution

For internal organizations, the simplest path is to upload the unpacked
folder via Chrome / Edge enterprise policy (or Firefox's signed `.xpi`
flow) and publish privately. Public Chrome Web Store distribution is a
larger task — the listing copy, screenshots, and privacy policy are
out of scope for the MVP.

## Roadmap

Phase 2 candidates (out of scope here): Firefox port, per-site
allowlist UX, PDF tab support (server-side fetch), right-click context
menu actions, server-side adoption telemetry.

Phase 3 (separate design doc required): authorized actions — letting
the extension type into the active tab on user confirmation.
