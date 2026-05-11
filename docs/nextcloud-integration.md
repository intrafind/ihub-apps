# Nextcloud Integration

The Nextcloud integration lets users browse and attach files from their Nextcloud instance directly inside iHub Apps chat interfaces. It uses Nextcloud's OAuth 2.0 server for authentication and the standard WebDAV endpoint for file access, so any reasonably recent Nextcloud release (22+) works out of the box.

## Features

- **Personal Files**: Browse and select files from the user's Nextcloud home directory
- **Folder Navigation**: Drill into folders, navigate via breadcrumbs, jump back to any level
- **Search**: Real-time filename search with debouncing
- **OAuth 2.0**: Per-user tokens with refresh-token rotation
- **Encrypted Token Storage**: AES-256-GCM encryption for stored tokens
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

> **Tip — multiple instances:** If you operate several Nextcloud servers, repeat this step on each instance and create one iHub provider per server.
>
> **Caveat — one active connection per user:** Tokens are stored under `contents/integrations/nextcloud/<userId>.json`, keyed by user and service name (not by provider ID — same model as Office 365 / Google Drive). If a single end user connects to more than one Nextcloud provider, the most recently completed OAuth flow wins; reconnecting via the picker switches them to that provider. Most deployments only configure one provider per service, so this rarely surfaces in practice.

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
