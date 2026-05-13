# Office 365 Integration

The Office 365 integration enables users to browse and upload files from OneDrive, SharePoint sites, and Microsoft Teams directly within iHub Apps chat interfaces.

## Features

- **Personal OneDrive**: Browse and select files from the user's personal OneDrive
- **SharePoint Sites**: Access files from SharePoint sites the user follows
- **Microsoft Teams**: Access document libraries from the user's joined Teams
- **File Search**: Search for files within a selected drive
- **Secure OAuth 2.0 PKCE Flow**: Enhanced security with Proof Key for Code Exchange
- **Encrypted Token Storage**: AES-256-GCM encryption for stored tokens
- **Automatic Token Refresh**: Seamless token renewal for uninterrupted access
- **Batch API Support**: Efficient retrieval of multiple team drives using Microsoft Graph batch requests

## Prerequisites

- A **Microsoft Azure account** with permission to register applications
- Access to the **Azure Portal** ([portal.azure.com](https://portal.azure.com))
- A **Microsoft 365 tenant** (the users must have Microsoft 365 accounts)
- An account with permission to grant admin consent for API permissions (or coordinate with your Azure AD administrator)

---

## Step 1: Create an Azure App Registration

1. Go to the [Azure Portal](https://portal.azure.com)
2. In the left navigation, search for and select **"Azure Active Directory"** (also called **Microsoft Entra ID**)
3. Select **"App registrations"** from the left menu
4. Click **"+ New registration"**
5. Fill in the registration form:
   - **Name**: `iHub Apps` (or your organization's preferred name)
   - **Supported account types**: Choose the option appropriate for your organization:
     - **"Accounts in this organizational directory only"** — Recommended for most deployments. Only users in your Azure AD tenant can sign in.
     - **"Accounts in any organizational directory"** — For multi-tenant deployments.
   - **Redirect URI**: Leave blank for now — you will add this in Step 3
6. Click **"Register"**
7. After the app is created, you will see the **Overview** page. **Note down** the following values:
   - **Application (client) ID** — you will need this for iHub Apps configuration
   - **Directory (tenant) ID** — you will need this for iHub Apps configuration

---

## Step 2: Configure API Permissions

The integration requires delegated permissions (acting on behalf of the signed-in user). No application-level permissions or admin credentials are used.

1. On your app registration page, select **"API permissions"** from the left menu
2. Click **"+ Add a permission"**
3. Select **"Microsoft Graph"**
4. Select **"Delegated permissions"**
5. Search for and add the following permissions:

   | Permission | Purpose |
   |------------|---------|
   | `User.Read` | Read the signed-in user's basic profile |
   | `Files.Read.All` | Read all files the user can access (OneDrive and SharePoint) |
   | `Sites.Read.All` | Read items in all SharePoint site collections the user can access |
   | `Team.ReadBasic.All` | Read basic information about Teams the user is a member of |
   | `Channel.ReadBasic.All` | Read basic information about Teams channels |
   | `offline_access` | Maintain access when the user is not actively using the app (required for refresh tokens) |

6. Click **"Add permissions"**
7. Click **"Grant admin consent for [your organization]"** and confirm

   > **Note**: The `Files.Read.All` and `Sites.Read.All` permissions require admin consent. Without admin consent being granted, users will be blocked from authorizing the application. Coordinate with your Azure AD administrator if you do not have the required permissions.

---

## Step 3: Add a Redirect URI

The redirect URI is the URL Microsoft redirects to after the user grants access. It must match exactly what iHub Apps sends during the OAuth flow.

1. On your app registration page, select **"Authentication"** from the left menu
2. Under **"Platform configurations"**, click **"+ Add a platform"**
3. Select **"Web"**
4. Under **"Redirect URIs"**, add the URI for your deployment:
   - **Production**: `https://your-ihub-domain.com/api/integrations/office365/{providerId}/callback`
   - **Development**: `http://localhost:3000/api/integrations/office365/{providerId}/callback`

   > **Important**: Replace `{providerId}` with the provider ID you will configure in the iHub Apps admin panel (e.g., `office365-1`). The URI must match exactly, including the provider ID.

5. Under **"Implicit grant and hybrid flows"**, leave all checkboxes unchecked
6. Click **"Configure"**

---

## Step 4: Create a Client Secret

1. On your app registration page, select **"Certificates & secrets"** from the left menu
2. Under **"Client secrets"**, click **"+ New client secret"**
3. Enter a **Description** (e.g., `iHub Apps`)
4. Select an **Expiry** period. Note that you will need to rotate this secret and update the iHub Apps configuration before it expires.
5. Click **"Add"**
6. **Immediately copy the secret Value** — it is only shown once. This is your **Client Secret**.

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
   | **Type** | Office 365 |
   | **Provider ID** | A unique identifier (e.g., `office365-1`) — must match the `{providerId}` in your redirect URI |
   | **Display Name** | Name shown to users (e.g., `OneDrive`) |
   | **Tenant ID** | The Directory (tenant) ID from Step 1 |
   | **Client ID** | The Application (client) ID from Step 1 |
   | **Client Secret** | The client secret value from Step 4 |
   | **Redirect URI** | Optional — leave blank to auto-detect from the incoming request URL |
   | **Site URL** | Optional — a specific SharePoint site URL if you want to restrict access to a single site |
   | **Drive ID** | Optional — a specific drive ID if you want to restrict access to a single drive |

6. Configure **Available Sources** (check the sources you want to make available to users):
   - **Personal OneDrive** — User's personal OneDrive files
   - **Followed SharePoint Sites** — SharePoint sites the user follows
   - **Microsoft Teams** — Document libraries from the user's joined Teams

7. Click **"Save"**

### Via platform.json (manual configuration)

Alternatively, configure the provider directly in `contents/config/platform.json`:

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "office365-1",
        "name": "office365-1",
        "displayName": "OneDrive & SharePoint",
        "type": "office365",
        "enabled": true,
        "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "clientSecret": "your-client-secret-value",
        "redirectUri": "https://your-ihub-domain.com/api/integrations/office365/office365-1/callback",
        "siteUrl": "",
        "driveId": "",
        "sources": {
          "personalDrive": true,
          "followedSites": true,
          "teams": true
        }
      }
    ]
  }
}
```

> **Security Note**: The `clientSecret` and `tenantId` are automatically encrypted using AES-256-GCM when saved through the admin UI. If editing `platform.json` directly, secrets will be encrypted on the next admin save.

---

## Step 6: Enable the Integration Feature Flag

The Office 365 integration requires the `integrations` feature flag to be enabled in your platform configuration.

In **Admin → Platform Settings** (or in `platform.json`):

```json
{
  "features": {
    "integrations": true
  }
}
```

---

## How Users Connect Their Microsoft Account

Once configured, users authorize iHub Apps to access their Microsoft 365 content:

1. Open a chat app that supports file uploads with cloud storage enabled
2. Click the **cloud storage** icon in the file picker
3. Select **Office 365** as the source
4. A **"Connect Office 365"** button appears — click it
5. The user is redirected to Microsoft's OAuth consent screen
6. The user logs in with their Microsoft account and grants the requested permissions
7. Microsoft redirects back to iHub Apps with an authorization code
8. iHub Apps exchanges the code for access and refresh tokens (stored encrypted)
9. The user can now browse their OneDrive, SharePoint sites, and Teams files

> **Token Lifetime**: Access tokens from Microsoft expire after approximately 1 hour. iHub Apps automatically refreshes them using the refresh token. If the refresh token is no longer valid (e.g., the user revoked consent), the user will be prompted to reconnect.

> **Consent Prompt**: The OAuth flow includes `prompt=consent` to ensure a refresh token is always issued. This means users will see the consent screen on every initial connection, even if they have previously authorized the app.

---

## Source Categories

The integration exposes three source categories that map to different parts of Microsoft 365:

| Source ID | Display Name | Description | Microsoft Graph Endpoint |
|-----------|-------------|-------------|--------------------------|
| `personal` | OneDrive | User's personal OneDrive drives | `/me/drives` |
| `sharepoint` | SharePoint Sites | Drives from sites the user follows | `/me/followedSites` then `/sites/{id}/drives` |
| `teams` | Microsoft Teams | Drives from the user's joined Teams | `/me/joinedTeams` then `/groups/{id}/drive` (batch) |

Each source is controlled by the `sources` configuration object in the provider settings. Set a source to `false` to hide it from users.

---

## Troubleshooting

### "Office 365 provider not found or not enabled"

- Verify the provider is configured in the admin panel
- Check that the `type` is set to `office365` (exactly, lowercase)
- Ensure `enabled` is set to `true`
- Confirm `tenantId`, `clientId`, and `clientSecret` are all present and non-empty

### "redirect_uri_mismatch" error from Microsoft

- The redirect URI registered in Azure must match **exactly** what iHub Apps sends
- The URI includes the provider ID: `/api/integrations/office365/{providerId}/callback`
- Common mismatches: trailing slash, `http` vs `https`, wrong port, wrong provider ID
- Check what URI iHub Apps is generating by looking at server logs when the OAuth flow starts
- If `redirectUri` is not set in the provider config, iHub Apps auto-detects it from the incoming request (using `X-Forwarded-Proto` and `X-Forwarded-Host` headers behind a reverse proxy)

### No refresh token received

- This can happen if `offline_access` is not included in the requested scopes, or if the user already authorized the app without it
- The OAuth flow always requests `offline_access` and uses `prompt=consent` to force re-consent
- If a user receives this error, they should disconnect and reconnect their account

### Users cannot connect — "AADSTS50020" or "AADSTS700016" errors

- `AADSTS50020`: The user's account does not belong to the configured tenant. Check `tenantId` matches the user's organization, or change supported account types to allow multiple organizations.
- `AADSTS700016`: The application was not found in the directory. Verify the `clientId` is correct and the app registration exists in the correct tenant.

### Admin consent not granted — "AADSTS65001" error

- This error means admin consent has not been granted for the required permissions
- An Azure AD administrator must visit the app registration in Azure Portal and click **"Grant admin consent"**
- Alternatively, the administrator can grant consent by navigating to: `https://login.microsoftonline.com/{tenantId}/adminconsent?client_id={clientId}`

### No files showing for SharePoint or Teams

- **SharePoint**: Files only appear for sites the user actively **follows**. Users must follow sites via SharePoint or the SharePoint mobile app. The integration queries `/me/followedSites`.
- **Teams**: Teams drives are retrieved only for teams the user has **joined**. If a team has no SharePoint site (which can happen for newly created or inactive teams), it is silently skipped.
- Check server logs — 404 responses for individual teams or sites are logged at debug level and skipped without blocking other results.

### Token refresh failures

- If automatic token refresh fails, the user will see a **"Reconnect"** prompt
- This typically happens when the refresh token has expired (Microsoft refresh tokens can expire after 90 days of inactivity by default), or when the user revoked the app's consent
- The user should disconnect and reconnect their Office 365 account
- After a failed refresh, iHub Apps automatically deletes the invalid tokens so the user can start a clean connection

### "Office 365 API rate limit exceeded"

- Microsoft Graph API enforces rate limits. The error includes a `retry-after` header indicating when to retry.
- This is typically a temporary condition. The user should wait a moment and try again.
- Consider reducing the number of sources enabled if users regularly hit limits during drive listing.

### Session required error

- The OAuth flow requires server-side sessions. Ensure your deployment includes a session middleware compatible with Express (e.g., `express-session`).
- If running behind a load balancer with multiple server instances, use a shared session store (e.g., Redis) so that the OAuth callback reaches the same session that initiated the flow.

---

## Security Considerations

- **Read-only access**: The integration requests only read permissions (`Files.Read.All`, `Sites.Read.All`) — it cannot create, modify, or delete files
- **Per-user tokens**: Each user connects their own Microsoft account; no shared service account is used
- **Encrypted storage**: Tokens are encrypted at rest using AES-256-GCM via `TokenStorageService`
- **PKCE**: OAuth flow uses Proof Key for Code Exchange (S256 method) to prevent authorization code interception attacks
- **State validation**: CSRF protection via session-stored state parameter, validated on callback
- **Session timeout**: OAuth sessions expire after 15 minutes if the user does not complete the authorization flow
- **Rate limiting**: OAuth initiation is rate-limited to 10 requests per minute per IP address
- **Input validation**: Drive IDs and file IDs passed to the Microsoft Graph API are validated against a strict character allowlist

---

## File Structure

```
server/
├── services/integrations/Office365Service.js   # Core OAuth & Microsoft Graph API service
└── routes/integrations/office365.js            # OAuth and browsing API routes

client/src/features/upload/
├── components/CloudFileBrowserShell.jsx        # Shared file-browser UI (all providers)
├── components/Office365FileBrowser.jsx         # Thin adapter over the shell
├── hooks/useCloudStorageBrowser.js             # Shared state-management factory
└── hooks/useOffice365Browser.js                # Thin adapter over the factory

contents/integrations/office365/                # Encrypted token storage (auto-created)
```
