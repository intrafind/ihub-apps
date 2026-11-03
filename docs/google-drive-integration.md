# Google Drive Integration

The Google Drive integration enables users to browse and upload files from Google Drive, Shared Drives, and files shared with them directly within iHub Apps chat interfaces.

## Features

- **My Drive**: Browse and select files from the user's personal Google Drive
- **Shared Drives**: Access files in Google Workspace Shared Drives (team drives)
- **Shared with Me**: Access files that others have shared with the user
- **Google Workspace Export**: Automatically converts Google Docs → PDF, Sheets → XLSX, Presentations → PDF
- **Search**: Real-time file search with debouncing
- **Secure OAuth 2.0 PKCE Flow**: Enhanced security with Proof Key for Code Exchange
- **Encrypted Token Storage**: AES-256-GCM encryption for stored tokens
- **Automatic Token Refresh**: Seamless token renewal for uninterrupted access

## Prerequisites

- A **Google Cloud Project** (free to create)
- Access to **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com))
- An account with permission to configure OAuth credentials for your organization

---

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click the project selector dropdown at the top of the page
3. Click **"New Project"**
4. Enter a **Project Name** (e.g., `iHub Apps Integration`)
5. Select your **Organization** and **Billing Account** if applicable
6. Click **"Create"**
7. Wait for the project to be created, then select it from the project dropdown

---

## Step 2: Enable the Google Drive API

1. In your Google Cloud project, navigate to **APIs & Services → Library**
2. Search for **"Google Drive API"**
3. Click on **Google Drive API**
4. Click **"Enable"**

---

## Step 3: Configure the OAuth Consent Screen

Before creating credentials, you must configure the OAuth consent screen that users will see when authorizing iHub Apps to access their Google Drive.

1. Navigate to **APIs & Services → OAuth consent screen**
2. Choose the **User Type**:
   - **Internal** — Recommended for Google Workspace organizations. Only users within your organization can authorize. No Google review required.
   - **External** — For applications accessible to any Google account. Requires Google review for production use (or keep in "Testing" mode for limited users).
3. Click **"Create"**
4. Fill in the **App information**:
   - **App name**: `iHub Apps` (or your organization's name)
   - **User support email**: Your support email address
   - **App logo**: Optional — upload your organization's logo
   - **Developer contact information**: Your email address
5. Click **"Save and Continue"**

### Add OAuth Scopes

6. On the **Scopes** page, click **"Add or Remove Scopes"**
7. Search for and add the following scopes:
   | Scope | Purpose |
   |-------|---------|
   | `https://www.googleapis.com/auth/drive.readonly` | Read-only access to Google Drive files |
   | `https://www.googleapis.com/auth/userinfo.profile` | Access user's basic profile info |
   | `https://www.googleapis.com/auth/userinfo.email` | Access user's email address |
8. Click **"Update"** then **"Save and Continue"**

### Add Test Users (External apps only)

9. If using **External** user type and the app is in **Testing** mode, add the Google accounts that should be allowed to authorize:
   - Click **"Add Users"**
   - Enter email addresses of test users
   - Click **"Add"**
10. Click **"Save and Continue"**
11. Review the summary and click **"Back to Dashboard"**

---

## Step 4: Create OAuth 2.0 Client Credentials

1. Navigate to **APIs & Services → Credentials**
2. Click **"+ Create Credentials"** → **"OAuth client ID"**
3. Select **Application type**: **"Web application"**
4. Enter a **Name** (e.g., `iHub Apps Google Drive`)
5. Under **Authorized redirect URIs**, click **"+ Add URI"** and add:
   - **Production**: `https://your-ihub-domain.com/api/integrations/googledrive/{installationId}/callback`
   - **Under a base path**: `https://your-ihub-domain.com/ihub/api/integrations/googledrive/{installationId}/callback`
   - **Development**: `http://localhost:3000/api/integrations/googledrive/{installationId}/callback`
   - These per-installation callbacks are aliases of iHub's one integration callback `…/api/integrations/oauth/callback`; registering that one instead (and entering it as the installation's **Redirect URI**) works as well.

   > **Important**: `{installationId}` is the id of the installation in iHub Apps (e.g., `googledrive` or `google-drive-2`). The redirect URI must match exactly, including the base path. The installation's **Settings** tab shows the URI to register, with a **Copy** button.

6. Click **"Create"**
7. A dialog will show your credentials. **Copy and save**:
   - **Client ID** (format: `xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com`)
   - **Client Secret** (format: `GOCSPX-xxxxxxxxxxxxxxxxxxxxxxx`)

   > You can always retrieve these later from **APIs & Services → Credentials** by clicking on the credential name.

---

## Step 5: Configure iHub Apps

Google Drive is the built-in installed integration **Google Drive** (`com.intrafind/google-drive`, a storage provider; see [Integrations](integrations.md#built-in-integrations)). Install it once per OAuth client. **The installation id is the provider id**: it is part of the callback URL and of every user's stored connection, and it never changes after the installation is created.

### Via Admin UI

1. Log in to iHub Apps as an administrator
2. Navigate to **Admin → Integrations**. Open the **Catalog** tab and click **Install** on **Google Drive**, choosing the installation id, or open an existing installation (an upgrade created it from the former `platform.cloudStorage` provider, under the id the provider had)
3. The installation's **Settings** tab is the Google Drive editor:

   | Section / field | Value |
   |-------|-------|
   | **Name** | Label shown to users (e.g., `Google Drive`) and description |
   | **Register iHub with the provider** | The **redirect URI to register** in Step 4, with a **Copy** button: derived from your browser's address, the base path and the installation id, or the configured one. **Redirect URI (optional)** overrides it for an unusual proxy setup |
   | **OAuth app → Client ID** | The Client ID from Step 4 |
   | **OAuth app → Client secret** | A credential of type secret (**Admin → Integrations → Credentials**) holding the Client Secret from Step 4 |
   | **Sources users may browse** | **My Drive**, **Shared drives**, **Shared with me** |
   | **Connection and users** | Whether it is enabled, how many users connected, and the **Connected users** dialog |

4. **Test connection** (checks the unsaved values, the redirect URI and the route to `accounts.google.com`, and counts the connected users), then **Install** (or **Save**)

### In `integrations.json`

```json
{
  "installed": [
    {
      "id": "googledrive",
      "definition": "com.intrafind/google-drive",
      "enabled": true,
      "label": { "en": "Google Drive" },
      "values": {
        "clientId": "xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com",
        "clientSecretRef": "integration-googledrive-clientSecretRef",
        "redirectUri": "https://your-ihub-domain.com/ihub/api/integrations/googledrive/googledrive/callback",
        "sourceMyDrive": true,
        "sourceSharedDrives": true,
        "sourceSharedWithMe": true
      },
      "auth": { "mode": "oauth-user" }
    }
  ]
}
```

> **Who may use it:** the groups decide (`groups.json` → `permissions.integrations`: `*`, the installation id, the definition id or `type:storage`). `/api/auth/status` lists, and the file picker offers, only the providers a user's groups grant; connecting, browsing and importing a provider the groups do not grant is refused. See [Integrations → Who may use an integration](integrations.md#who-may-use-an-integration).

> **Which apps offer it:** an app binds storage providers under **Admin → Apps → Edit → Integrations → Storage providers** (`app.integrations`: the installation id, `com.intrafind/google-drive` for every Google Drive installation, or `type:storage`). See [Apps → Files from storage providers](apps.md#files-from-storage-providers).

> The client secret is a credential reference, never a value. Migration V200 moved the former `platform.cloudStorage` provider into an installation; migration V206 renamed it to the provider's former id and installed further providers V200 had parked in `config/cloudStorage.unmigrated.json`, so registered redirect URIs and the users' connections stay valid.

---

## Step 6: Enable the Integration Feature Flag

The Google Drive integration requires the `integrations` feature flag to be enabled in your platform configuration.

In **Admin → Platform → Features** (or in `platform.json`):

```json
{
  "features": {
    "integrations": true
  }
}
```

---

## How Users Connect Their Google Account

Once configured, users authorize iHub Apps to access their Google Drive:

1. Open a chat app that binds the Google Drive installation (or all storage providers)
2. Open the **+** menu of the message box; the storage providers are listed there
3. Select the Google Drive provider (by its label, when there are several)
4. A **"Connect Google Drive"** button appears — click it
5. The user is redirected to Google's OAuth consent screen
6. The user logs in with their Google account and grants the requested permissions
7. Google redirects back to iHub Apps with an authorization code
8. iHub Apps exchanges the code for access and refresh tokens (stored encrypted)
9. The user can now browse and select files from their Google Drive

> **Token Lifetime**: Access tokens expire after 1 hour. iHub Apps automatically refreshes them using the refresh token. If a refresh token is not available, the user will be prompted to reconnect.

---

## Google Workspace Document Export

Google Workspace documents (Docs, Sheets, Presentations) cannot be downloaded as-is and are automatically exported:

| Google Document Type | Exported As |
|---------------------|-------------|
| Google Docs | PDF |
| Google Sheets | XLSX (Excel) |
| Google Slides / Presentations | PDF |
| Google Drawings | PNG |

---

## Troubleshooting

### "Google Drive provider not found or not enabled"

- Verify the installation exists under **Admin → Integrations** and is enabled
- The request names the installation by its id (`?providerId=<installation id>`); without one the routes answer `400 STORAGE_PROVIDER_REQUIRED`, for an unknown id `404 STORAGE_PROVIDER_NOT_FOUND`

### "redirect_uri_mismatch" error from Google

- The redirect URI in Google Cloud Console must match **exactly** what iHub Apps uses
- The URI includes the base path and the installation id: `/ihub/api/integrations/googledrive/{installationId}/callback`
- Check for trailing slashes, protocol mismatches (`http` vs `https`), port differences or a missing base path
- The installation's **Settings** tab shows the URI iHub Apps sends. Without a configured **Redirect URI** it is derived from each request (scheme, host and base path, from `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Prefix` of a trusted proxy); the `GOOGLEDRIVE_OAUTH_REDIRECT_URI` environment variable is no longer read
- In development, `http://localhost:3000` is typical; check your server port

### No refresh token received

- This can happen if the user has previously authorized the app without granting offline access
- Solution: The user should **disconnect** their Google account and **reconnect** — the OAuth flow uses `prompt=consent` and `access_type=offline` to ensure a refresh token is returned each time

### Users outside your organization cannot connect (Internal app)

- If the OAuth consent screen is set to **Internal**, only users in your Google Workspace organization can authorize
- For external users, change the User Type to **External** in the OAuth consent screen settings

### "This app isn't verified" warning

- This appears for **External** apps in Testing mode or apps requesting sensitive scopes
- Click **"Advanced"** → **"Go to {App Name} (unsafe)"** to proceed during development/testing
- For production use with External apps, submit your app for Google verification

### Files are not loading / API errors

- Verify the Google Drive API is **enabled** in your Google Cloud project
- Check that the user's Google account has access to the files they are trying to browse
- Check server logs for detailed error messages

### Token refresh failures

- If Google rejects the refresh token, the user will see a **"Reconnect"** prompt. iHub Apps then deletes the stored tokens (as it does when no refresh token is stored).
- This typically happens when the refresh token has been revoked (e.g., user changed their Google password, or revoked app access in [myaccount.google.com/permissions](https://myaccount.google.com/permissions))
- Any other refresh failure keeps the stored tokens: a network error, a Google outage (5xx or 429), an expired or wrong client secret, or a provider that was disabled or removed. Requests then fail with *"Google Drive is temporarily unavailable. Please try again in a moment."*, and the connection status still shows the account as connected. Access returns by itself once the problem clears. For an expired client secret, update it in the provider: every user is back without reconnecting.

### Connecting fails with `?integration_error=<code>`

When connecting fails, the user is sent back to the page they started from (the chat, the file picker or **Settings → Integrations**) with `integration_error=<code>&integration=<installation id>` added to the URL — the same result shape for every integration; the Connect card and the settings page show the matching message:

| Code | Cause | Fix |
|------|-------|-----|
| `invalid_state` | The sign-in is unknown or was already used (the `state` is single use), or was started for another installation. | Have the user sign in to iHub Apps and start again from **Settings → Integrations** in the same browser. Check that no proxy strips the iHub sign-in cookie. |
| `user_mismatch` | The callback came from a different user than the one who started the sign-in, or from a browser where nobody is signed in to iHub Apps. | Have the user sign in to iHub Apps and start again from **Settings → Integrations** in the same browser. Check that no proxy strips the iHub sign-in cookie. |
| `state_expired` | The sign-in is older than 15 minutes. | Start again and finish the Google consent within 15 minutes. |
| `access_denied` | The user declined the Google consent screen. | Start again and approve the access. |
| `oauth_failed` | Google returned another error on the redirect back. | Check the server logs. |
| `missing_code` | The callback arrived without an authorization code, for example when the URL was opened by hand. | Start again from **Settings → Integrations**. |
| `exchange_failed` | Exchanging the code for tokens failed, for example because of a redirect URI mismatch or a wrong client secret. | Check the server logs and the redirect URI in the Google Cloud project. |

The sign-in is kept in the storage provider every worker shares (`integration-oauth-flows`), so the callback can land on any worker, and no sticky routing is needed. With several instances they share the `contents/` volume (as every multi-server deployment does) and the same `TOKEN_ENCRYPTION_KEY`, which encrypts the PKCE verifier. See [Integrations → Connections](integrations.md#connections).

---

## Security Considerations

- **Read-only scope**: The integration requests only `drive.readonly` — it cannot create, modify, or delete files
- **Per-user tokens**: Each user connects their own Google account; no shared service account is used
- **Encrypted storage**: Tokens are encrypted at rest using AES-256-GCM
- **PKCE**: OAuth flow uses Proof Key for Code Exchange (S256) to prevent authorization code interception attacks
- **Disconnect revokes**: disconnecting revokes the tokens at Google (`https://oauth2.googleapis.com/revoke`) before deleting them
- **State validation**: The OAuth `state` is an opaque handle of a sign-in kept server-side, bound to the installation and the signed-in user who started it, valid once and for 15 minutes. The callback requires the same user and the same installation, so a sign-in from one browser cannot complete in another and a code for one installation cannot complete another's.
- **PKCE verifier protection**: The PKCE code verifier stays on the server, encrypted with AES-256-GCM; the browser never sees it
- **Shared OAuth client**: the sign-in, refresh and disconnect run through iHub's one OAuth client and connection service, like every other integration (see [Integrations → Connections](integrations.md#connections)); a refresh token is only ever sent to the authorization server and client that issued it
- **Sign-in lifetime**: A started sign-in expires after 15 minutes. A user who does not finish the Google consent in that time has to start again (`integration_error=state_expired`).
- **Rate limiting**: starting a sign-in (`POST /api/integrations/<installation id>/connect`) is limited to 20 per user and minute; API endpoints are limited to 60 requests/minute

---

## File Structure

```
server/
├── services/integrations/GoogleDriveService.js   # Drive API calls and Google-specific OAuth endpoints
├── services/integrations/cloudStorageConfig.js   # The installations in the provider shape; redirect URI derivation
├── services/integrations/OAuthIntegrationBase.js # Provider config, callback URL, 401 retry (tokens via the connection service)
├── routes/integrations/googledrive.js            # Browsing API routes and the /callback alias
├── routes/integrations/oauthIntegrationFactory.js # The vendor-registered /callback aliases
├── routes/integrations/userIntegrations.js       # GET /api/integrations, POST /api/integrations/:id/connect|reconnect|disconnect
├── routes/integrations/oauthCallback.js        # The one integration OAuth callback
└── services/integrations/auth/                 # Shared OAuth client and connection service

client/src/features/upload/
├── components/CloudFileBrowserShell.jsx          # Shared file-browser UI (all providers)
├── components/GoogleDriveFileBrowser.jsx         # Thin adapter over the shell
├── hooks/useCloudStorageBrowser.js               # Shared state-management factory
└── hooks/useGoogleDriveBrowser.js                # Thin adapter over the factory

client/src/features/admin/components/integrations/editors/
└── StorageProviderEditor.jsx                     # The Settings tab (with storageEditorModel.js)

contents/integrations/googledrive/                # Encrypted token storage, <userId>__<installationId>.json
```
