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
| `GET  /api/admin/browser-extension/status`          | Admin: read current configuration including signing-key extension ID            |
| `POST /api/admin/browser-extension/enable`          | Admin: enable the integration, auto-create the OAuth client, generate signing key |
| `POST /api/admin/browser-extension/disable`         | Admin: disable                                                                 |
| `PUT  /api/admin/browser-extension/config`          | Admin: update display name, description, starter prompts, extension IDs, allowed groups |
| `POST /api/admin/browser-extension/rotate-key`      | Admin: rotate the RSA signing key (changes the extension ID)                    |
| `GET  /api/admin/browser-extension/download.zip`    | Admin: download the customised extension as an unsigned ZIP                     |
| `GET  /api/admin/browser-extension/download.crx`    | Admin: download the customised extension as a CRX3-signed package               |

All public routes are gated behind the `integrations` feature flag and the
`browserExtension.enabled` setting — both must be on.

The extension source ships in this repository under `browser-extension/`,
but admins **do not normally distribute the source folder**. The download
endpoints above package a customised build (with the iHub base URL, OAuth
client ID, starter prompts and a fixed extension-ID-deriving `manifest.key`
all baked in) so end users just install and sign in — no manual setup.

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

## Step 3 — (Automatic) The signing key + extension ID

When you click **Enable** in Step 2, the server **also** generates an RSA
signing keypair and stores the private half at
`contents/.browser-extension-key.pem` (mode 0o600). The public half lives
in `platform.json` under `browserExtension.signingKey.publicKey`.

The Chromium extension ID is a deterministic SHA-256-based fingerprint of
the public key, so the same packaged build assigns the same extension ID
to every user who installs it. The server writes that ID into the OAuth
client's redirect URI allowlist automatically:

- `https://<extension-id>.chromiumapp.org/cb` (Chrome / Edge)
- `https://<extension-id>.extensions.allizom.org/cb` (Firefox)

You **do not need to copy any extension IDs by hand for the standard
deployment path**. The **Additional unpacked extension IDs** textarea on
the admin page is only for developers side-loading their own dev build
(see [Step 5, Option C](#option-c--developer-side-load-build)).

**Rotating the key.** The admin page has a **Rotate signing key** button
that issues a brand-new keypair. The previous extension ID is preserved
in the OAuth client's redirect URIs as a one-cycle grace window so users
on the old build can still authenticate while they update; rotate again
to drop it. Rotating invalidates every previously-distributed packaged
copy — use sparingly.

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

The iHub admin page packages a customised, signed copy of the extension
on demand. Two formats are produced from the same signing key, so the
extension ID is identical regardless of which one you ship.

### Option A — Download ZIP (recommended for pilots)

Best for internal testers and small groups.

1. On the **Browser Extension** admin page, click **Download ZIP**. You
   receive `ihub-extension-<id>.zip`.
2. Distribute the ZIP however you like (email, shared drive, internal
   intranet).
3. Each recipient unzips the file, opens `chrome://extensions` (Edge:
   `edge://extensions`), toggles **Developer mode**, clicks **Load
   unpacked**, and selects the unzipped folder.
4. Done — they click the iHub icon, the side panel skips setup and goes
   straight to **Sign in**.

The `manifest.key` field in the bundled `manifest.json` is what gives
every recipient the same extension ID. The base URL, OAuth client ID,
display name, and starter prompts are baked into a generated
`runtime-config.js` inside the ZIP.

### Option B — Download CRX (recommended for production)

Best for organization-wide rollout on managed devices.

1. Click **Download CRX** to get `ihub-extension-<id>.crx`. The file is
   a CRX3-signed package, signed by the same RSA key whose public half
   lives in `manifest.key`.
2. Host the `.crx` on an internal HTTPS URL.
3. Push it to managed devices via Chrome / Edge enterprise policy
   (`ExtensionInstallForcelist` with the URL of the CRX) or Firefox
   policy (after re-signing for AMO; out of scope here).
4. End users see the extension appear in their browser, click the iHub
   icon, and sign in. They cannot accidentally uninstall it if your
   policy forbids it.

End users can also drag-and-drop the `.crx` onto `chrome://extensions`
for an ad-hoc install — handy for support engineers but not recommended
for at-scale rollout because it bypasses central policy.

### Option C — Developer side-load build

Useful when you actively edit the extension source against a dev iHub
instance. The packaged-download flow above is preferable in almost all
other cases.

The extension UI is now a React app built by Vite, so the source folder
on its own is not loadable — Chrome needs the built JS / CSS chunks to
sit alongside `manifest.json`. There's an npm script that does the
build + copy in one step:

1. Pull the iHub Apps repository and run `npm run install:all`.
2. Build the extension once: `npm run extension:build`. This runs
   `vite build` and copies the output into
   `browser-extension/extension/` and `browser-extension/assets/` (both
   git-ignored).
3. Visit `chrome://extensions`, toggle **Developer mode**, click
   **Load unpacked**, and select the `browser-extension/` folder.
4. Copy the random extension ID Chrome assigns. Paste it into
   **Additional unpacked extension IDs** on the admin page (`/admin/browser-extension`)
   and click **Save**. This adds your dev ID to the OAuth client's
   redirect-URI allowlist alongside any packaged-build ID.
5. Open the extension's options page, enter your iHub base URL, click
   **Save**. The side panel now shows the Sign-in screen → click
   **Sign in** and you're done.

You **do not need to generate a signing key** for this workflow — the
signing key is only required for the packaged ZIP / CRX downloads where
we want a deterministic extension ID. Unpacked dev installs use the
random ID Chrome assigns plus the manual `Additional unpacked extension
IDs` textarea above.

Whenever you change React code under `client/extension/` or
`client/src/features/{office,extension}/`, re-run `npm run extension:build`
and click the **Reload** icon on the extension card in
`chrome://extensions`. The SW restarts automatically.

To clean up: `npm run extension:clean` removes the copied dist
artefacts; the source tree stays intact.

When the extension is loaded unpacked, the placeholder
`extension/runtime-config.js` ships `IHUB_RUNTIME_CONFIG = null`, so the
React app falls back to the iHub base URL the user typed in the options
page and fetches the runtime config from
`/api/integrations/browser-extension/config` on startup. The packaged
ZIP / CRX overwrite that file with the deployment's baked settings.

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

### `Download Extension` button is greyed out / 404

`Download Extension` is enabled only when both the integration is enabled
**and** a signing key has been generated. Click **Disable** then **Enable**
on the admin page to regenerate the signing key (the **Enable** handler
is idempotent — it only generates one if `contents/.browser-extension-key.pem`
is missing).

### Existing installed packaged copies stop signing in after `Rotate signing key`

Rotating the key changes the derived extension ID. The previous ID is
preserved on the OAuth client's redirect URI allowlist for one rotation
cycle so users on the old build still authenticate. Distribute the
freshly downloaded ZIP / CRX promptly; rotate again only once everyone
is on the new build (the second rotation drops the old ID).

### `GET /api/integrations/browser-extension/config` works but `POST /api/oauth/token` is blocked by CORS

This is the canonical "GET works, POST fails" symptom and almost always means
the iHub server is configured with `cors.origin: "*"` (a wildcard) **and**
`cors.credentials: true` (the default). The browser:

- Lets simple GETs through — no preflight, the wildcard `Access-Control-Allow-Origin: *` is fine on its own
- **Blocks POST preflights** because the spec forbids `Access-Control-Allow-Origin: *` when paired with `Access-Control-Allow-Credentials: true`

iHub already auto-detects this combination at startup and downgrades the
literal `"*"` to "echo the request's Origin header" — which is the
spec-compliant equivalent of "allow any origin with credentials". You will
see this warning in the server log when it kicks in:

```
CORS configured with origin: "*" and credentials: true — echoing the request
origin instead, because the browser blocks responses with both headers at the
same time. Set credentials: false to keep the literal "*", or replace "*"
with an explicit allowlist.
```

If you still hit the issue, your CORS config probably has a non-wildcard
allowlist that doesn't include the extension's `chrome-extension://<id>`
origin. Either:

1. Add `chrome-extension://<id>` to `cors.origin` in `platform.json`, or
2. Use the recommended packaged-download flow — Chrome extension installs
   from a `chrome-extension://` URL **with `host_permissions` for the iHub
   host bypass CORS entirely** for fetches from the service worker. The
   browser-extension package generated by `/api/admin/browser-extension/download.zip`
   includes the right manifest for this.

### Tokens persist after `Sign out`

Sign-out clears `chrome.storage.session` (access token) and removes the
refresh token from `chrome.storage.local`, but it does **not** revoke the
underlying iHub session cookie or the OAuth client's grants. To fully
revoke a user, disable their iHub account or remove them from the
allowed group — the next refresh attempt will fail.

### Chrome rejects the iHub HTTPS certificate during sign-in

`chrome.identity.launchWebAuthFlow` requires HTTPS in production and
will refuse to load a URL whose certificate Chrome considers invalid.
Self-signed dev certificates trigger this immediately — the extension's
sign-in window opens, briefly shows the Chrome interstitial, and closes
with `Authorization page could not be loaded`.

Pick **one** of the following for development; production deployments
should always use a real CA-issued certificate.

#### Option A — Use mkcert to issue a locally-trusted certificate (recommended)

[mkcert](https://github.com/FiloSottile/mkcert) installs a local CA into
your operating system's trust store and Chrome's NSS DB, then issues
certificates signed by that CA. Chrome accepts them without warnings.

```bash
# One-time setup
brew install mkcert nss          # macOS; Linux: see mkcert README
mkcert -install                  # installs the local CA into OS + browsers

# Issue a cert for your iHub dev hostname
cd /path/to/ihub-apps
mkcert -cert-file ./certs/ihub.local.pem \
       -key-file ./certs/ihub.local-key.pem \
       ihub.local 127.0.0.1 ::1

# Point iHub at the new cert (in .env or environment)
SSL_CERT=./certs/ihub.local.pem
SSL_KEY=./certs/ihub.local-key.pem
```

Add `127.0.0.1 ihub.local` to `/etc/hosts`, restart iHub, and reload
the extension. Sign-in now works against `https://ihub.local:3000`.

#### Option B — Trust your existing self-signed certificate

If you already have a self-signed cert and don't want to switch to
mkcert, install the cert into the OS trust store so Chrome accepts it:

- **macOS**: open the `.pem` / `.crt` in **Keychain Access** → drag it
  into the **System** keychain → double-click → **Trust** → *Always
  Trust* for SSL. Restart Chrome.
- **Linux**: copy the cert to `/usr/local/share/ca-certificates/` and
  run `sudo update-ca-certificates`. Chromium / Chrome on Linux uses
  the NSS DB, so also import via `certutil -d sql:$HOME/.pki/nssdb -A
  -t "C,," -n ihub-dev -i ihub.crt`. Restart Chrome.
- **Windows**: double-click the `.cer` → **Install Certificate** →
  *Local Machine* → *Trusted Root Certification Authorities*. Restart
  Chrome.

#### Option C — Whitelist just the cert by SPKI fingerprint (no system trust changes)

Compute the SPKI hash and launch Chrome with a flag that ignores cert
errors only for that exact public key — safer than the blanket
`--ignore-certificate-errors`:

```bash
# Compute SPKI hash from your cert
openssl x509 -in ihub.crt -pubkey -noout \
  | openssl rsa -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | openssl enc -base64

# Launch a fresh Chrome profile with that hash whitelisted
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/chrome-ihub-dev \
  --ignore-certificate-errors-spki-list=YOUR_BASE64_HASH_HERE
```

This is per-launch and per-profile — fine for a dev loop, **not**
suitable for shipping to users.

#### Option D — Tunnel through a public HTTPS endpoint

If you can't trust certs locally (corporate device, etc.), expose your
local iHub through a tunnel that terminates a real cert for you:

- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  — `cloudflared tunnel --url http://localhost:3000` gives you a
  `*.trycloudflare.com` URL with a valid cert.
- [`ngrok`](https://ngrok.com/) — `ngrok http https://localhost:3000`
  works similarly.

Set the tunnel URL as the iHub base URL in the extension options, and
make sure the tunnel host is forwarded into Chrome's WebAuth window
correctly. **Ensure the iHub server sees the right
`X-Forwarded-Proto` / `X-Forwarded-Host`** so generated redirect URIs
match the tunnel hostname (the extension's redirect URI is fixed —
`https://<extension-id>.chromiumapp.org/cb` — but iHub still derives
its own absolute base URL from request headers in some places).

#### What does **not** work

- Bypassing the warning by clicking "Advanced → Proceed to site"
  affects only normal browser tabs, **not** `launchWebAuthFlow`. The
  WebAuth flow uses an isolated network stack that does not honour
  Chrome's per-site cert exceptions.
- `--ignore-certificate-errors` (without `-spki-list`) is broadly
  ignored by recent Chrome builds and shows a security warning banner.

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
