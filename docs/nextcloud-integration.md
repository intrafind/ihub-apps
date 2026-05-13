# Nextcloud Integration

The Nextcloud integration lets users browse and attach files from their Nextcloud instance directly inside iHub Apps chat interfaces. It uses Nextcloud's OAuth 2.0 server for authentication and the standard WebDAV endpoint for file access, so any reasonably recent Nextcloud release (22+) works out of the box.

## Features

- **Personal Files**: Browse and select files from the user's Nextcloud home directory
- **Folder Navigation**: Drill into folders, navigate via breadcrumbs, jump back to any level
- **Search**: Real-time filename search with debouncing
- **OAuth 2.0**: Per-user tokens with refresh-token rotation
- **Encrypted Token Storage**: AES-256-CBC encryption for stored user tokens (same as the Office 365 / Google Drive flow; the platform-secret encryption used for `clientSecret` in `platform.json` is AES-256-GCM)
- **Automatic Token Refresh**: Seamless renewal so users stay connected
- **Multi-Instance**: Configure multiple Nextcloud providers if your users are spread across different Nextcloud servers

## Prerequisites

- A reachable **Nextcloud instance** (22 or newer recommended)
- **Administrator access** to the Nextcloud instance so you can register an OAuth 2.0 client
- HTTPS on both iHub Apps and Nextcloud (Nextcloud's OAuth app refuses non-HTTPS redirect URIs in production)

---

## Step 1: Register an OAuth 2.0 Client in Nextcloud

> **Tip:** The easiest workflow is to do **Step 2 first** so iHub Apps shows you the exact callback URL to register. Open **Admin → Integrations → Nextcloud → Add Provider** in iHub, type the **Name** (provider ID) you want to use, and copy the auto-generated **Callback URL** straight into the Redirection URI field below. Then come back and finish step 1.

1. Sign in to your Nextcloud instance as an administrator.
2. Go to **Settings → Administration → Security**.
3. Scroll to the **OAuth 2.0 clients** section.
4. Enter a **Name** for the client (e.g. `iHub Apps`).
5. Enter the **Redirection URI** — either paste the value from iHub's admin UI (recommended) or construct it manually:

   ```
   https://<your-ihub-host>/api/integrations/nextcloud/<providerId>/callback
   ```

   - Replace `<your-ihub-host>` with your iHub Apps hostname.
   - Replace `<providerId>` with the provider ID you will create in iHub (e.g. `nextcloud-main`).

   > The redirect URI must match exactly — including scheme, host, port (if any), path, and the provider ID segment. The iHub admin UI displays the auto-detected callback URL live as you type the provider ID, with a copy button — using it avoids manual transcription mistakes.

6. Click **Add**. Nextcloud will show you a **Client Identifier** and a **Secret**. Copy both — the secret is shown only once.

> **Tip — multiple instances:** If you operate several Nextcloud servers, repeat this step on each instance and create one iHub provider per server. End users can be connected to all of them concurrently — tokens are stored per `(user, service, provider)` so flows don't overwrite each other.

---

## Step 2: Configure the Nextcloud Provider in iHub Apps

You can configure providers via the admin UI or by editing `contents/config/platform.json` directly.

### Option A: Admin UI (recommended)

1. Sign in to iHub Apps as an administrator.
2. Navigate to **Admin → Integrations → Nextcloud**.
3. Toggle **Cloud Storage** on if it isn't already.
4. Click **Add Provider** and fill in:
   - **Name** (provider ID, e.g. `nextcloud-main`) — must match the `<providerId>` you used in the redirect URI above.
   - **Display Name** — the friendly label shown to end users (e.g. `Company Nextcloud`).
   - **Provider Type** — `Nextcloud`.
   - **Nextcloud Server URL** — base URL of the instance, no trailing slash (e.g. `https://nextcloud.example.com`).
   - **Client ID** — the Client Identifier from step 1.
   - **Client Secret** — the Secret from step 1.
   - **Redirect URI** — optional; leave blank to let iHub auto-detect it from the request, or paste the full URL you registered in Nextcloud.
5. Click **Save**.

### Option B: `platform.json`

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "nextcloud-main",
        "name": "nextcloud-main",
        "displayName": "Company Nextcloud",
        "type": "nextcloud",
        "enabled": true,
        "serverUrl": "https://nextcloud.example.com",
        "clientId": "<client-identifier-from-nextcloud>",
        "clientSecret": "<client-secret-from-nextcloud>",
        "redirectUri": "https://ihub.example.com/api/integrations/nextcloud/nextcloud-main/callback",
        "sources": {
          "personalFiles": true
        }
      }
    ]
  }
}
```

> **Secrets at rest:** `clientSecret` is automatically encrypted on disk using AES-256-GCM the next time the admin UI saves the platform config (or you can paste an already-encrypted value). Environment-variable placeholders like `${NEXTCLOUD_CLIENT_SECRET}` are passed through unchanged.

---

## Step 3: User Sign-In Flow

Once configured, end users see Nextcloud as an option in the cloud storage picker that appears when they upload a file inside a chat:

1. The user opens an app that has uploads enabled.
2. They click the upload icon and pick **Cloud Storage**.
3. They select the Nextcloud provider.
4. They click **Connect to Nextcloud** — they are redirected to the Nextcloud login page, sign in (and grant the OAuth scope), and are redirected back to iHub.
5. iHub stores their encrypted access token + refresh token. From now on the user can browse their Nextcloud files directly from the picker.

The token is per-user and per-provider — switching Nextcloud instances requires reconnecting.

---

## How It Works

- **Authentication**: OAuth 2.0 authorization-code flow against `<serverUrl>/apps/oauth2/authorize` and `<serverUrl>/apps/oauth2/api/v1/token`. Nextcloud rotates refresh tokens on every refresh, so iHub stores the new refresh token returned with each access token.
- **User Identity**: After token exchange iHub calls `<serverUrl>/ocs/v2.php/cloud/user` (OCS API) to resolve the authenticated user's Nextcloud login. This login is used as the path segment when building WebDAV URLs.
- **File Listing**: PROPFIND (`Depth: 1`) against `<serverUrl>/remote.php/dav/files/<userId>/<folderPath>/`. The response is parsed for file ID, name, size, MIME type, last modified date, and whether the entry is a collection.
- **File Download**: GET against the same WebDAV path. The bytes are streamed back to the browser via the iHub backend so the user's Nextcloud credentials never leave the server.

## Security Considerations

- **PKCE not supported by Nextcloud OAuth**: iHub relies on the session-bound `state` parameter for CSRF protection, which matches what Nextcloud's OAuth 2.0 app supports.
- **Path-traversal protection**: All `folderPath` / `filePath` parameters are validated to reject `..` segments and NUL bytes before being passed to WebDAV.
- **Encrypted tokens at rest**: Access and refresh tokens are written to `contents/integrations/nextcloud/<userId>.json` via `TokenStorageService.encryptTokens`, which encrypts with AES-256-CBC (the same crypto used for Office 365 / Google Drive user tokens; AES-256-GCM is only used by `TokenStorageService.encryptString` for platform-secret encryption like `clientSecret` in `platform.json`).
- **Rate limiting**: The OAuth initiation endpoint is rate-limited to 10 requests per minute per IP to prevent abuse.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `invalid_redirect_uri` from Nextcloud | The redirect URI registered in Nextcloud doesn't exactly match the one iHub is sending. | Re-register the OAuth client in Nextcloud with the exact URI shown in the iHub admin UI hint, including the provider ID segment. |
| User sees `Nextcloud Not Connected` after consent | Cookies blocked or session lost during the redirect. | Make sure iHub Apps and Nextcloud are reachable over HTTPS and that no proxy strips the session cookie. |
| 401 on every file action | Refresh token expired or revoked. | Have the user click **Disconnect** then **Connect to Nextcloud** to re-authorize. |
| File listing is empty | The OAuth client was registered for a different Nextcloud user, or the user has no files in that path. | Verify the connected account in **Settings → Integrations**, and check `<serverUrl>/index.php/apps/files` in a browser. |

## Limitations

- **Single drive per user**: Nextcloud exposes the user's files as one drive — there's no concept of a "Shared with me" tree separate from the home directory the way Google Drive has. Shared folders show up inline in the listing.
- **No PKCE**: Nextcloud's OAuth 2.0 app doesn't support PKCE; CSRF protection relies on the `state` parameter only.
- **WebDAV search**: iHub uses client-side filtering of the current folder for search rather than a server-side DAV SEARCH query, because the response shape varies between Nextcloud versions. Search is therefore scoped to the folder you're currently viewing.

---

# Chat-from-Nextcloud (Embedded UI)

The flow described above is the **picker** flow — the user is inside iHub and reaches into Nextcloud to attach files. iHub also ships a second, complementary surface: the **embedded** flow, where the user is inside Nextcloud and starts a chat in iHub with the currently selected document(s). This mirrors the Outlook add-in (chat about the current email) and the browser extension (chat about the active tab).

Internally the embed reuses 100% of the picker's server-side machinery — same `NextcloudService`, same `/api/integrations/nextcloud/download` endpoint, same encrypted per-user OAuth tokens. The only new pieces are a thin admin/runtime config (`nextcloudEmbed` in `platform.json`), a dedicated `/nextcloud/full-embed.html` entry, and a small Nextcloud-side app that wires "Chat with iHub" into Files.

## Architecture in 30 seconds

1. The Nextcloud app shell adds a **Chat with iHub** action to the Nextcloud Files UI.
2. On click, it navigates to the app's host page inside the Nextcloud chrome (`/apps/ihub_chat/`), which iframes `<ihub>/nextcloud/full-embed.html` with the selected file paths encoded in the URL hash.
3. The embed boots, fetches `/api/integrations/nextcloud-embed/config` for branding + starter prompts + the allowlist of acceptable parent origins, and renders the standard iHub `<App />` behind an OAuth gate (login → app picker → chat).
4. The first time a chat opens, `useNextcloudEmbedAttachments` downloads each selected path through the existing per-user OAuth `/download` endpoint and pre-attaches the files to the chat uploader. From there it's the regular iHub chat flow.

The embed does **not** receive any Nextcloud token. The user OAuth-links Nextcloud to iHub once (via the picker flow above) and the same grant powers both surfaces.

## Step 1 — Enable in iHub Apps

1. Sign in to iHub Apps as an administrator.
2. Open **Admin → Integrations → Nextcloud Embed**.
3. Click **Enable**. iHub auto-creates a public PKCE OAuth client used by the embed for the iHub login (this is the user's iHub identity, not their Nextcloud identity).
4. Add at least one entry under **Allowed Nextcloud Origins** — for example `https://cloud.example.com`. The embed page refuses to be iframed by any origin not on this list (CSP `frame-ancestors`), and the in-iframe bridge ignores postMessages whose `event.origin` isn't on the list.
5. Customise the **Display Name**, **Description**, and **Starter Prompts** as desired. These appear in the embed when the selected app has no starter prompts of its own.

Copy the **Embed URL** from the page if you're configuring a custom Nextcloud-side integration; the shipped `nextcloud-app/` skeleton already points at this URL.

## Step 2 — Install the Nextcloud app

The iHub repo ships a Nextcloud app skeleton at `nextcloud-app/`. It is a minimum-viable shell intended as a starting point, not a polished App Store listing.

```bash
cd nextcloud-app
make build
cp -R . /var/www/nextcloud/apps/ihub_chat/
sudo -u www-data php /var/www/nextcloud/occ app:enable ihub_chat
```

See `nextcloud-app/README.md` for the full instructions.

## Step 3 — End-user flow

1. The user opens **Files** in Nextcloud, selects one or more documents, and chooses **Chat with iHub** from the action menu.
2. The Nextcloud app navigates to its own host page, which iframes `<ihub>/nextcloud/full-embed.html#providerId=…&paths=…`.
3. If the user is not signed in to iHub, the embed shows the standard iHub sign-in prompt.
4. If the user has not yet linked their Nextcloud account to iHub, downloading any selected document fails with a 401 and the auto-attach falls back to the cloud-storage picker for them to OAuth-link.
5. The embed opens the iHub app picker; once an app is selected, `useNextcloudEmbedAttachments` pre-attaches the selected Nextcloud documents to the chat uploader. Sending a message uses the documents through the regular file-upload chat path.

## How embed auth differs from the picker

| Aspect | Picker flow | Embed flow |
|---|---|---|
| Where the user starts | Inside an iHub app | Inside Nextcloud Files |
| File selection | In the iHub cloud picker | In the Nextcloud Files UI |
| iHub authentication | Existing iHub session | Embedded OAuth (auto-created PKCE client) |
| Nextcloud authentication | OAuth-link via the picker | Same OAuth-link reused; first-time users link from the embed CTA |
| Server-side code path | `/api/integrations/nextcloud/*` | **Same** `/api/integrations/nextcloud/*` |
| New iHub config | `cloudStorage.providers[]` (existing) | `nextcloudEmbed` (this section) |

## Security considerations specific to the embed

- **CSP frame-ancestors**: the embed page is served with `Content-Security-Policy: frame-ancestors 'self' <allowedHostOrigins>`. A Nextcloud origin not on the admin allowlist cannot iframe iHub.
- **postMessage origin check**: the in-iframe selection bridge rejects any `message` whose `event.origin` is not on the same allowlist. There is no fallback to `*`.
- **Hash selection sanitisation**: the URL-hash form (`#paths=…`) is sanitised the same way as postMessage payloads — limited to 50 paths, no `..` segments, no NUL bytes, max 4 KiB per path.
- **No host-injected token**: the embed never receives a Nextcloud token. File reads always go through iHub's encrypted per-user OAuth grant, the same one the picker uses.
