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

> **Tip:** The easiest workflow is to do **Step 2 first** so iHub Apps shows you the exact callback URL to register. Install **Nextcloud** under **Admin → Integrations → Catalog** with the installation id you want (e.g. `nextcloud-hq`), open its **Settings** tab and copy the **Redirect URI to register** straight into the Redirection URI field below. Then come back and finish step 1.

1. Sign in to your Nextcloud instance as an administrator.
2. Go to **Settings → Administration → Security**.
3. Scroll to the **OAuth 2.0 clients** section.
4. Enter a **Name** for the client (e.g. `iHub Apps`).
5. Enter the **Redirection URI** — either paste the value from iHub's admin UI (recommended) or construct it manually:

   ```
   https://<your-ihub-host>[/<base path>]/api/integrations/nextcloud/<installationId>/callback
   ```

   - Replace `<your-ihub-host>` with your iHub Apps hostname, followed by its base path when iHub runs under one (e.g. `/ihub`).
   - Replace `<installationId>` with the id of the Nextcloud installation in iHub (e.g. `nextcloud-hq`).

   > The redirect URI must match exactly — including scheme, host, port (if any), base path, path, and the installation id. The installation's **Settings** tab shows it with a **Copy** button — using it avoids manual transcription mistakes.

6. Click **Add**. Nextcloud will show you a **Client Identifier** and a **Secret**. Copy both — the secret is shown only once.

> **Tip — several Nextcloud servers:** repeat this step on each server and install **Nextcloud** once per server in iHub (each installation with its own id, server URL and OAuth client). End users can be connected to all of them at once — tokens are stored per user and installation (`<userId>__<installationId>.json`), so flows don't overwrite each other.

---

## Step 2: Configure the Nextcloud Provider in iHub Apps

Nextcloud is the built-in installed integration **Nextcloud** (`com.intrafind/nextcloud`, a storage provider; see [Integrations](integrations.md#built-in-integrations)). Install it once per Nextcloud server. **The installation id is the provider id**: it is part of the callback URL, of every user's stored connection and of the embed plugin's `ihub_provider_id`, and it never changes after the installation is created.

### Option A: Admin UI (recommended)

1. Sign in to iHub Apps as an administrator.
2. Navigate to **Admin → Integrations**, open the **Catalog** tab and click **Install** on **Nextcloud** with the installation id you want (or open an installation an upgrade created; it keeps the id the provider had, e.g. `nextcloud-main`).
3. The installation's **Settings** tab is the Nextcloud editor:
   - **Name** — the label shown to end users (e.g. `Company Nextcloud`) and a description.
   - **Register iHub with the provider** — the **Redirect URI to register** in step 1, with a **Copy** button (derived from your browser's address, the base path and the installation id, or the configured one), and **Redirect URI (optional)** to override the derived URL for an unusual proxy setup.
   - **OAuth app** — **Nextcloud server URL** (base URL of the instance, no trailing slash, e.g. `https://nextcloud.example.com`), **Client ID** (the Client Identifier from step 1), **Client secret** (a credential of type secret, **Admin → Integrations → Credentials**, holding the Secret from step 1).
   - **Connection and users** — whether it is enabled, how many users connected, and the **Connected users** dialog.
4. **Test connection** (checks the unsaved values, the redirect URI and `<serverUrl>/status.php`, and counts the connected users), then **Install** (or **Save**).

### Option B: `integrations.json`

```json
{
  "installed": [
    {
      "id": "nextcloud",
      "definition": "com.intrafind/nextcloud",
      "enabled": true,
      "label": { "en": "Company Nextcloud" },
      "values": {
        "serverUrl": "https://nextcloud.example.com",
        "clientId": "<client-identifier-from-nextcloud>",
        "clientSecretRef": "integration-nextcloud-clientSecretRef",
        "redirectUri": "https://ihub.example.com/ihub/api/integrations/nextcloud/nextcloud/callback"
      },
      "auth": { "mode": "oauth-user" }
    }
  ]
}
```

> **Who may use it:** the groups decide (`groups.json` → `permissions.integrations`: `*`, the installation id, the definition id or `type:storage`). `/api/auth/status` lists, and the file picker offers, only the providers a user's groups grant; connecting, browsing and importing a provider the groups do not grant is refused. See [Integrations → Who may use an integration](integrations.md#who-may-use-an-integration).

> **Which apps offer it:** an app binds storage providers under **Admin → Apps → Edit → Integrations → Storage providers** (`app.integrations`: the installation id, `com.intrafind/nextcloud` for every Nextcloud installation, or `type:storage`). See [Apps → Files from storage providers](apps.md#files-from-storage-providers).

> **Secrets at rest:** the client secret lives in the credential store (`contents/config/credentials.json`, AES-256-GCM), referenced by `clientSecretRef`; the installation never holds a value. Migration V200 moved the former `platform.cloudStorage` provider into an installation; migration V206 renamed it to the provider's former id (e.g. `nextcloud-main`) and installed a second Nextcloud provider V200 had parked in `config/cloudStorage.unmigrated.json`, so registered redirect URIs, the users' connections and the embed plugin's `ihub_provider_id` stay valid.

---

## Step 3: User Sign-In Flow

Once configured, end users see each Nextcloud installation in the cloud file picker of the apps that bind it:

1. The user opens an app that binds the Nextcloud installation (or all storage providers).
2. They open the **+** menu of the message box; the storage providers are listed there.
3. They select the Nextcloud provider (by its label, when there are several).
4. They click **Connect to Nextcloud** — they are redirected to the Nextcloud login page, sign in (and grant the OAuth scope), and are redirected back to iHub.
5. iHub stores their encrypted access token + refresh token. From now on the user can browse their Nextcloud files directly from the picker.

The token is per user and per installation — each Nextcloud server is connected on its own.

---

## How It Works

- **Authentication**: OAuth 2.0 authorization-code flow against `<serverUrl>/apps/oauth2/authorize` and `<serverUrl>/apps/oauth2/api/v1/token`. Nextcloud rotates refresh tokens on every refresh, so iHub stores the new refresh token returned with each access token.
- **User Identity**: After token exchange iHub calls `<serverUrl>/ocs/v2.php/cloud/user` (OCS API) to resolve the authenticated user's Nextcloud login. This login is used as the path segment when building WebDAV URLs.
- **File Listing**: PROPFIND (`Depth: 1`) against `<serverUrl>/remote.php/dav/files/<userId>/<folderPath>/`. The response is parsed for file ID, name, size, MIME type, last modified date, and whether the entry is a collection.
- **File Download**: GET against the same WebDAV path. The bytes are streamed back to the browser via the iHub backend so the user's Nextcloud credentials never leave the server.

## Security Considerations

- **PKCE and state**: the sign-in runs through iHub's shared OAuth client like every other integration: it sends a PKCE (S256) challenge, which Nextcloud versions without PKCE support ignore and newer ones check, and the `state` is an opaque handle of a sign-in kept server-side, bound to the installation and the signed-in user who started it, valid once and for 15 minutes. The callback requires the same user and installation, so a sign-in from one browser cannot complete in another.
- **Changed server URL**: when an installation's server URL (or client id) changes, every user's connection to it is invalidated and their tokens deleted, so a token issued by one Nextcloud is never sent to another; users connect again.
- **Path-traversal protection**: All `folderPath` / `filePath` parameters are validated to reject `..` segments and NUL bytes before being passed to WebDAV.
- **Encrypted tokens at rest**: Access and refresh tokens are written to `contents/integrations/nextcloud/<userId>__<installationId>.json` via `TokenStorageService.encryptTokens`, which encrypts with AES-256-CBC (the same crypto used for Office 365 / Google Drive user tokens; AES-256-GCM is only used by `TokenStorageService.encryptString` for platform-secret encryption like `clientSecret` in `platform.json`).
- **Rate limiting**: starting a sign-in (`POST /api/integrations/<installation id>/connect`) is limited to 20 per user and minute.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `invalid_redirect_uri` from Nextcloud | The redirect URI registered in Nextcloud doesn't exactly match the one iHub is sending. | Re-register the OAuth client in Nextcloud with the exact URI the installation's **Settings** tab shows, including the base path and the installation id. Without a configured **Redirect URI** iHub derives it from each request (scheme, host and base path from `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Prefix` of a trusted proxy); the `NEXTCLOUD_OAUTH_REDIRECT_URI` environment variable is no longer read. |
| Back in iHub after consent, Nextcloud is still `Not Connected` and the URL has `?integration_error=user_mismatch` or `invalid_state` | The callback needs the iHub sign-in of the user who started the flow (`user_mismatch`). It is refused when a different user, or nobody, is signed in in that browser (for example the sign-in cookie was blocked or the iHub session ended during consent), when the sign-in belongs to another installation, or when it was already used. | Have the user sign in to iHub Apps and start again from **Settings → Integrations** in the same browser. Allow cookies for iHub Apps and make sure no proxy strips the iHub sign-in cookie. |
| `?integration_error=state_expired` | The sign-in is older than 15 minutes: consent took too long. | Start again and approve within 15 minutes. |
| `?integration_error=access_denied`, `oauth_failed`, `missing_code` or `exchange_failed` | The user declined, Nextcloud returned an error, the callback arrived without an authorization code, or exchanging the code for tokens failed (for example a wrong client secret or redirect URI). | Start again; for `exchange_failed` check the server logs and the OAuth client registered in Nextcloud. |
| 401 on every file action | Refresh token expired or revoked. | The file picker shows the Connect card (**Reconnect**); or have the user click **Disconnect**, then **Connect**, under **Settings → Integrations**. |
| File actions fail with `Nextcloud is temporarily unavailable` | Refreshing the access token failed for a reason that says nothing about the user's grant: Nextcloud is unreachable or erroring, or the OAuth client secret is wrong or no longer valid. iHub keeps the user's tokens. | Check that Nextcloud is reachable and the provider configuration is correct, then retry. The user does not need to reconnect. |
| File listing is empty | The OAuth client was registered for a different Nextcloud user, or the user has no files in that path. | Verify the connected account in **Settings → Integrations**, and check `<serverUrl>/index.php/apps/files` in a browser. |

The sign-in is kept in the storage provider every worker shares (`integration-oauth-flows`), so the callback can land on any worker, and no sticky routing is needed. With several instances they share the `contents/` volume (as every multi-server deployment does) and the same `TOKEN_ENCRYPTION_KEY`, which encrypts the PKCE verifier. See [Integrations → Connections](integrations.md#connections).

## Limitations

- **Single drive per user**: Nextcloud exposes the user's files as one drive — there's no concept of a "Shared with me" tree separate from the home directory the way Google Drive has. Shared folders show up inline in the listing.
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
| iHub config | a Nextcloud installation (Admin → Integrations) | `nextcloudEmbed` (this section) |

## Security considerations specific to the embed

- **CSP frame-ancestors**: the embed page is served with `Content-Security-Policy: frame-ancestors 'self' <allowedHostOrigins>`. A Nextcloud origin not on the admin allowlist cannot iframe iHub.
- **postMessage origin check**: the in-iframe selection bridge rejects any `message` whose `event.origin` is not on the same allowlist. There is no fallback to `*`.
- **Hash selection sanitisation**: the URL-hash form (`#paths=…`) is sanitised the same way as postMessage payloads — limited to 50 paths, no `..` segments, no NUL bytes, max 4 KiB per path.
- **No host-injected token**: the embed never receives a Nextcloud token. File reads always go through iHub's encrypted per-user OAuth grant, the same one the picker uses.
