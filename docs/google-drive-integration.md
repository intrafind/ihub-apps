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
   - **Production**: `https://your-ihub-domain.com/api/integrations/googledrive/{providerId}/callback`
   - **Development**: `http://localhost:3000/api/integrations/googledrive/{providerId}/callback`

   > **Important**: Replace `{providerId}` with the provider ID you will set in the iHub Apps admin panel (e.g., `google-drive-1`). The redirect URI must match exactly.

6. Click **"Create"**
7. A dialog will show your credentials. **Copy and save**:
   - **Client ID** (format: `xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com`)
   - **Client Secret** (format: `GOCSPX-xxxxxxxxxxxxxxxxxxxxxxx`)

   > You can always retrieve these later from **APIs & Services → Credentials** by clicking on the credential name.

---

## Step 5: Configure iHub Apps

### Via Admin UI

1. Log in to iHub Apps as an administrator
2. Navigate to **Admin → Cloud Storage**
3. Enable **Cloud Storage** if not already enabled
4. Click **"Add Provider"**
5. Fill in the provider details:
   | Field | Value |
   |-------|-------|
   | **Type** | Google Drive |
   | **Provider ID** | A unique identifier (e.g., `google-drive-1`) — must match the `{providerId}` in your redirect URI |
   | **Display Name** | Name shown to users (e.g., `Google Drive`) |
   | **Client ID** | The Client ID from Step 4 |
   | **Client Secret** | The Client Secret from Step 4 |
   | **Redirect URI** | Optional — leave blank to auto-detect from the incoming request URL |

6. Configure **Available Sources** (check the sources you want to make available):
   - **My Drive** — User's personal Google Drive
   - **Shared Drives** — Google Workspace Shared Drives / Team Drives
   - **Shared with Me** — Files shared with the user by others

7. Click **"Save"**

### Via platform.json (manual configuration)

Alternatively, configure the provider directly in `contents/config/platform.json`:

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "google-drive-1",
        "name": "google-drive-1",
        "displayName": "Google Drive",
        "type": "googledrive",
        "enabled": true,
        "clientId": "xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com",
        "clientSecret": "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxx",
        "redirectUri": "https://your-ihub-domain.com/api/integrations/googledrive/google-drive-1/callback",
        "sources": {
          "myDrive": true,
          "sharedDrives": true,
          "sharedWithMe": true
        }
      }
    ]
  }
}
```

> **Security Note**: The `clientSecret` is automatically encrypted using AES-256-GCM when saved through the admin UI. If editing `platform.json` directly, the secret will be encrypted on the next admin save.

---

## Step 6: Enable the Integration Feature Flag

The Google Drive integration requires the `integrations` feature flag to be enabled in your platform configuration.

In **Admin → Platform Settings** (or in `platform.json`):

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

1. Open a chat app that supports file uploads with cloud storage enabled
2. Click the **cloud storage** icon in the file picker
3. Select **Google Drive** as the source
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

- Verify the provider is configured in the admin panel
- Check that the `type` is set to `googledrive` (not `google_drive`)
- Ensure `enabled` is set to `true`

### "redirect_uri_mismatch" error from Google

- The redirect URI in Google Cloud Console must match **exactly** what iHub Apps uses
- The URI includes the `providerId`: `/api/integrations/googledrive/{providerId}/callback`
- Check for trailing slashes, protocol mismatches (`http` vs `https`), or port differences
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

- If automatic token refresh fails, the user will see a **"Reconnect"** prompt
- This typically happens when the refresh token has been revoked (e.g., user changed their Google password, or revoked app access in [myaccount.google.com/permissions](https://myaccount.google.com/permissions))

---

## Security Considerations

- **Read-only scope**: The integration requests only `drive.readonly` — it cannot create, modify, or delete files
- **Per-user tokens**: Each user connects their own Google account; no shared service account is used
- **Encrypted storage**: Tokens are encrypted at rest using AES-256-GCM
- **PKCE**: OAuth flow uses Proof Key for Code Exchange to prevent authorization code interception attacks
- **State validation**: CSRF protection via session-stored state parameter
- **Rate limiting**: OAuth initiation is rate-limited (10 requests/minute); API endpoints are limited to 60 requests/minute

---

## File Structure

```
server/
├── services/integrations/GoogleDriveService.js   # Core OAuth & Drive API service
└── routes/integrations/googledrive.js            # OAuth and browsing API routes

client/src/features/upload/
├── components/CloudFileBrowserShell.jsx          # Shared file-browser UI (all providers)
├── components/GoogleDriveFileBrowser.jsx         # Thin adapter over the shell
├── hooks/useCloudStorageBrowser.js               # Shared state-management factory
└── hooks/useGoogleDriveBrowser.js                # Thin adapter over the factory

contents/integrations/googledrive/                # Encrypted token storage (auto-created)
```
