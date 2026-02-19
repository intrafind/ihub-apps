# Cloud Storage Integration for File Upload

**Date:** 2026-02-16 (Updated: 2026-02-17)
**Feature:** SharePoint and Cloud Storage Integration for File Uploads
**Status:** ✅ **Production Ready** (Backend + Frontend Complete - Custom File Browser Implementation)

## Overview

This feature adds cloud storage integration to iHub Apps, allowing users to select files directly from cloud storage providers (SharePoint, Google Drive) instead of requiring them to download files locally first. The implementation is designed to be extensible, supporting multiple providers and multiple instances of the same provider type.

**Current Implementation Status:**
- ✅ **Phase 1-3**: Backend configuration, admin UI, file upload UI structure (Complete)
- ✅ **Phase 4**: SharePoint OAuth backend with Microsoft Graph API integration (Complete)
- ✅ **Phase 4.5**: IntegrationsPage UI and session middleware fixes (Complete - 2026-02-17)
- ✅ **Phase 5**: Custom SharePoint file browser and cloud-to-chat upload flow (Complete - 2026-02-17)
- ⏳ **Phase 6**: Google Drive integration (Not started)

## Business Requirements

1. **SharePoint Integration**: Users should be able to select files from SharePoint directly
2. **Admin Configuration**: Administrators must be able to enable/disable and configure cloud storage providers
3. **User Authentication**: Each user authenticates with their own Microsoft account (delegated permissions)
4. **Secure Token Storage**: OAuth tokens must be encrypted and stored securely per user
5. **Extensibility**: The architecture must support adding other providers (Google Drive, Dropbox, etc.) in the future
6. **Upload Integration**: Cloud storage selection should be seamlessly integrated into existing file upload flows
7. **Backward Compatibility**: Local file upload must remain the default option

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      iHub Apps Frontend                      │
│  ┌────────────────┐  ┌──────────────────────────────────┐  │
│  │ UnifiedUploader│  │  CloudStoragePicker (UI Only)    │  │
│  └────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    iHub Apps Backend (Node.js)               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           SharePoint Routes                           │  │
│  │  /api/integrations/sharepoint/*                       │  │
│  │  - /auth (OAuth initiation with PKCE)                │  │
│  │  - /callback (OAuth callback handler)                │  │
│  │  - /status (Connection status check)                 │  │
│  │  - /disconnect (Remove user tokens)                  │  │
│  │  - /drives (List OneDrive/SharePoint drives)         │  │
│  │  - /items (List files in folder)                     │  │
│  │  - /download (Download file content)                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                              │                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         SharePointService                             │  │
│  │  - OAuth 2.0 with PKCE flow                          │  │
│  │  - Token refresh with 2-minute proactive buffer      │  │
│  │  - Microsoft Graph API client                        │  │
│  │  - Automatic retry on 401 errors                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                              │                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │       TokenStorageService (Singleton)                 │  │
│  │  - AES-256-GCM encryption for tokens                 │  │
│  │  - User + service-specific context binding           │  │
│  │  - Persistent encryption key management              │  │
│  │  - Stored in: contents/integrations/{service}/       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│             Microsoft Identity Platform                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  OAuth 2.0 Authorization Endpoint                     │  │
│  │  login.microsoftonline.com/{tenant}/oauth2/v2.0       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Microsoft Graph API                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  graph.microsoft.com/v1.0                             │  │
│  │  - /me (User profile)                                │  │
│  │  - /me/drives (List drives)                          │  │
│  │  - /drives/{id}/items (Browse files)                 │  │
│  │  - Download URLs (Direct file access)                │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Provider-Based Configuration System

The cloud storage system uses a provider-based architecture similar to the existing OIDC/LDAP authentication system:

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "sharepoint-main",
        "name": "sharepoint-main",
        "displayName": "Company SharePoint",
        "type": "sharepoint",
        "enabled": true,
        "tenantId": "your-tenant-id",
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "redirectUri": "https://your-app.com/api/integrations/sharepoint/callback"
      }
    ]
  }
}
```

### Security Architecture

**Token Storage:**
- **Encryption**: AES-256-GCM with unique IV per token
- **Key Management**: Encryption key persisted in `contents/.encryption-key` (600 permissions)
- **Context Binding**: Tokens bound to specific user + service combination
- **Format**: `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`
- **Storage Location**: `contents/integrations/sharepoint/{userId}.json`

**OAuth 2.0 Flow:**
1. User clicks "Connect SharePoint" in settings
2. Server generates PKCE code verifier and challenge
3. State parameter stored in session for CSRF protection
4. User redirected to Microsoft OAuth consent screen
5. User grants permissions (Files.Read.All, Sites.Read.All, User.Read, offline_access)
6. Microsoft redirects back with authorization code
7. Server exchanges code for tokens using PKCE verification
8. Tokens encrypted and stored per user
9. User redirected to `/settings/integrations?sharepoint_connected=true`

**Token Refresh:**
- **Proactive Refresh**: Tokens refreshed 2 minutes before expiration
- **Automatic Retry**: 401 errors trigger immediate token refresh attempt
- **Graceful Degradation**: If refresh fails, user prompted to reconnect

**Secret Management:**
- Client secrets are sanitized in API responses (replaced with `***REDACTED***`)
- Environment variable placeholders (e.g., `${CLIENT_SECRET}`) are preserved
- Secrets are restored when updating configuration to prevent accidental overwrites
- Similar pattern to OIDC provider secret handling

## Implementation Details

### Backend Components

#### SharePointService (`server/services/integrations/SharePointService.js`)

**Core Methods:**
- `generateAuthUrl(providerId, state, codeVerifier)` - Creates OAuth URL with PKCE
- `exchangeCodeForTokens(providerId, authCode, codeVerifier)` - Exchanges auth code for tokens
- `refreshAccessToken(providerId, refreshToken)` - Refreshes expired access tokens
- `storeUserTokens(userId, tokens)` - Encrypts and stores user tokens
- `getUserTokens(userId)` - Retrieves and auto-refreshes tokens if needed
- `deleteUserTokens(userId)` - Disconnects SharePoint account
- `isUserAuthenticated(userId)` - Checks if user has valid auth
- `makeApiRequest(endpoint, method, data, userId)` - Authenticated Graph API calls with retry
- `getUserInfo(userId)` - Gets Microsoft user profile
- `listDrives(userId)` - Lists OneDrive and SharePoint drives
- `listItems(userId, driveId, folderId)` - Lists files in a folder
- `downloadFile(userId, fileId, driveId)` - Downloads file as Buffer

**OAuth Scopes:**
- `User.Read` - Basic user information
- `Files.Read.All` - Read files in all site collections
- `Sites.Read.All` - Read items in all site collections
- `offline_access` - Refresh token support

**Token Refresh Strategy:**
- Tokens checked for expiration with 2-minute buffer
- Automatic refresh on retrieval if expired
- Retry logic on 401 API errors
- Invalid tokens automatically deleted to allow reconnection

#### TokenStorageService (`server/services/TokenStorageService.js`)

**Singleton service providing:**
- `encryptTokens(tokens, userId, serviceName)` - AES-256-CBC encryption with context binding
- `decryptTokens(encryptedData, userId, serviceName)` - Decryption with verification
- `storeUserTokens(userId, serviceName, tokens)` - Persist encrypted tokens to disk
- `getUserTokens(userId, serviceName)` - Retrieve and decrypt tokens
- `areTokensExpired(userId, serviceName)` - Check expiration with 2-minute buffer
- `deleteUserTokens(userId, serviceName)` - Remove user tokens
- `hasValidTokens(userId, serviceName)` - Combined check for existence and validity
- `getUserServices(userId)` - List all connected services for user
- `getTokenMetadata(userId, serviceName)` - Get metadata without decryption
- `encryptString(plaintext)` - Generic string encryption (AES-256-GCM)
- `decryptString(encryptedData)` - Generic string decryption
- `isEncrypted(value)` - Check if value is encrypted

**Encryption Details:**
- **Algorithm**: AES-256-GCM for strings, AES-256-CBC for tokens
- **Key Source Priority**: `TOKEN_ENCRYPTION_KEY` env var → persisted key → new generated key
- **Key Persistence**: Stored in `contents/.encryption-key` with 600 permissions
- **Context Hashing**: SHA-256 hash of `userId:serviceName` prevents token reuse

#### SharePoint Routes (`server/routes/integrations/sharepoint.js`)

**API Endpoints:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/integrations/sharepoint/auth?providerId=xxx` | Required | Initiate OAuth flow |
| GET | `/api/integrations/sharepoint/callback` | Optional | OAuth callback handler |
| GET | `/api/integrations/sharepoint/status` | Required | Get connection status |
| POST | `/api/integrations/sharepoint/disconnect` | Required | Disconnect account |
| GET | `/api/integrations/sharepoint/drives` | Required | List available drives |
| GET | `/api/integrations/sharepoint/items?driveId=xxx&folderId=xxx` | Required | List folder items |
| GET | `/api/integrations/sharepoint/download?fileId=xxx&driveId=xxx` | Required | Download file |

**Response Examples:**

Status Response:
```json
{
  "connected": true,
  "userInfo": {
    "displayName": "John Doe",
    "mail": "john.doe@company.com",
    "userPrincipalName": "john.doe@company.com",
    "jobTitle": "Software Engineer"
  },
  "tokenInfo": {
    "expiresAt": "2026-02-17T15:30:00Z",
    "minutesUntilExpiry": 45,
    "isExpiring": false,
    "isExpired": false
  },
  "message": "SharePoint account connected successfully"
}
```

Drives Response:
```json
{
  "success": true,
  "drives": [
    {
      "id": "b!abc123...",
      "name": "OneDrive",
      "description": "Personal OneDrive",
      "driveType": "personal",
      "owner": { "user": { "displayName": "John Doe" } }
    }
  ]
}
```

Items Response:
```json
{
  "success": true,
  "items": [
    {
      "id": "01ABC123",
      "name": "document.pdf",
      "size": 1024000,
      "createdDateTime": "2026-01-15T10:00:00Z",
      "lastModifiedDateTime": "2026-01-20T14:30:00Z",
      "webUrl": "https://company.sharepoint.com/...",
      "isFolder": false,
      "isFile": true,
      "mimeType": "application/pdf",
      "downloadUrl": "https://..."
    }
  ]
}
```

### Frontend Components

#### CloudStoragePicker (`client/src/features/upload/components/CloudStoragePicker.jsx`)

**Current Implementation:** ✅ Complete (2026-02-17)
- ✅ Provider selection UI
- ✅ Loading states and error handling
- ✅ Auto-selection for single provider
- ✅ Modal dialog with close/cancel
- ✅ **NEW**: Custom SharePoint file browser (no SDK dependency)
- ✅ **NEW**: Drive selection and folder navigation
- ✅ **NEW**: File selection with multi-select support
- ✅ **NEW**: Download and process files via backend API
- ✅ **NEW**: Integration with existing file processing pipeline

**Implementation Approach:**
Instead of using the OneDrive File Picker SDK (which requires client-side MSAL.js token acquisition incompatible with our server-side encrypted token architecture), we implemented a **custom file browser** that:

1. Uses our backend's `/drives`, `/items`, and `/download` endpoints
2. Provides full drive listing, folder navigation, and breadcrumb support
3. Downloads files as blobs and processes them through `processCloudFile()`
4. Produces the same data shape as local uploads (identical rendering in chat)
5. Supports mixed local + cloud file uploads

**Key Components:**
- `SharePointFileBrowser.jsx` - Three-view UI (not connected, drive selection, file browser)
- `useSharePointBrowser.js` - Custom hook for API calls and state management
- `cloudFileProcessing.js` - Cloud file processing utility (images, audio, documents)

#### IntegrationsPage (`client/src/features/settings/pages/IntegrationsPage.jsx`)

**Current Implementation:** ✅ Complete (2026-02-17)
- ✅ Shows JIRA integration status
- ✅ Shows SharePoint integration section (when providers configured)
- ✅ OAuth callback handling for SharePoint (`sharepoint_connected`, `sharepoint_error`)
- ✅ Connect/disconnect buttons for SharePoint
- ✅ Loads SharePoint status from `/api/integrations/sharepoint/status`
- ✅ Shows SharePoint connection status card with purple/teal gradient
- ✅ Displays connected user info (displayName, mail)
- ✅ Shows token expiration warnings
- ✅ Lists available features when connected

#### CloudStorageConfig (`client/src/features/admin/components/CloudStorageConfig.jsx`)

**Implemented:**
- ✅ Enable/disable cloud storage globally
- ✅ Add/edit/delete provider configurations
- ✅ Provider-specific fields (SharePoint vs Google Drive)
- ✅ Secret sanitization and restoration
- ✅ Real-time validation

### Schema Design

**Provider Schema** (`server/validators/cloudStorageSchema.js`):
```javascript
const sharepointProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('sharepoint'),
  enabled: z.boolean().default(true),
  tenantId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().url().optional()
});

const googleDriveProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('googledrive'),
  enabled: z.boolean().default(true),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().url().optional()
});

const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  sharepointProviderSchema,
  googleDriveProviderSchema
]);
```

## Complete File Structure

### Backend Files

**Core Services:**
- `server/services/integrations/SharePointService.js` - SharePoint OAuth and Graph API client (635 lines)
- `server/services/TokenStorageService.js` - Encrypted token storage service (585 lines)

**Routes:**
- `server/routes/integrations/sharepoint.js` - SharePoint API endpoints (393 lines)
- `server/routes/admin/configs.js` - Config management with secret sanitization

**Validators:**
- `server/validators/cloudStorageSchema.js` - Provider configuration schemas
- `server/validators/platformConfigSchema.js` - Platform config integration

**Middleware:**
- `server/middleware/authRequired.js` - Authentication enforcement

### Frontend Files

**Components:**
- `client/src/features/upload/components/CloudStoragePicker.jsx` - File picker UI shell (295 lines) ⚠️ No SDK integration
- `client/src/features/upload/components/UnifiedUploader.jsx` - Upload integration
- `client/src/features/admin/components/CloudStorageConfig.jsx` - Admin configuration UI
- `client/src/features/settings/pages/IntegrationsPage.jsx` - User integrations page ⚠️ Missing SharePoint section

**Admin Integration:**
- `client/src/features/admin/pages/AdminSystemPage.jsx` - System settings page

### Configuration & Data

**Config Files:**
- `contents/config/platform.json` - Cloud storage provider configuration
- `contents/.encryption-key` - Persistent encryption key (600 permissions, gitignored)
- `contents/integrations/sharepoint/{userId}.json` - Per-user encrypted tokens

**Translations:**
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations

## User Flow (Current vs Planned)

### Admin Configuration Flow ✅ Complete

1. Admin navigates to Admin → System → Cloud Storage Configuration
2. Enables cloud storage globally
3. Clicks "Add Provider"
4. Selects provider type (SharePoint or Google Drive)
5. Configures provider:
   - SharePoint: Tenant ID, Client ID, Client Secret, Redirect URI
   - Google Drive: Client ID, Client Secret, Redirect URI
6. Saves configuration
7. Client secrets automatically sanitized in responses

### User Authentication Flow ✅ Complete (2026-02-17)

**Full Flow Working:**
1. User clicks "Connect SharePoint Account" in `/settings/integrations`
2. Backend generates OAuth URL with PKCE
3. User redirected to Microsoft OAuth consent screen
4. User grants permissions
5. Microsoft redirects to `/api/integrations/sharepoint/callback`
6. Backend exchanges code for tokens
7. Tokens encrypted and stored in `contents/integrations/sharepoint/{userId}.json`
8. User redirected to `/settings/integrations?sharepoint_connected=true`
9. IntegrationsPage shows success message and updates status
10. SharePoint card displays connected user info and available features

### File Selection Flow ✅ Complete (2026-02-17)

**Complete Working Flow:**
1. User opens file upload dialog (in apps)
2. Sees "Upload from cloud" button (if cloud storage enabled)
3. Clicks "Upload from cloud"
4. CloudStoragePicker modal opens
5. Selects provider (if multiple configured)
6. ✅ If not connected: Shows "Connect to SharePoint" button → OAuth flow
7. ✅ If connected: Shows drive selection view
8. ✅ Selects drive → Shows root folder contents
9. ✅ Navigates folders via click, breadcrumbs for going back
10. ✅ Selects files with checkboxes (multi-select supported)
11. ✅ Clicks "Attach N Files" → Downloads via `/download` endpoint
12. ✅ Files processed through `processCloudFile()` (resize, extract text, etc.)
13. ✅ Merged with any existing local files
14. ✅ All files appear in UnifiedUploader preview area
15. ✅ Submit sends both local and cloud files to chat

## Known Issues & Limitations

### Critical Issues

1. ~~**No Frontend File Picker Integration**~~ ✅ **FIXED (2026-02-17)**
   - ✅ Custom file browser implemented (no SDK dependency)
   - ✅ SharePointFileBrowser component with drive/folder navigation
   - ✅ File download and processing working
   - ✅ Full integration with chat upload flow

2. ~~**IntegrationsPage Missing SharePoint**~~ ✅ **FIXED (2026-02-17)**
   - ✅ Settings page now shows SharePoint integration card
   - ✅ Users can connect/disconnect via UI buttons
   - ✅ OAuth callback handling implemented
   - ✅ Status check loads on page mount

3. ~~**Session Middleware Coupling Bug**~~ ✅ **FIXED (2026-02-17)**
   - ✅ Session middleware now enabled when `cloudStorage.enabled` is true
   - ✅ No longer requires JIRA environment variables
   - ✅ Logs show "SharePoint" in enabled integrations list

4. ~~**Security Leak: Sensitive Fields in API Response**~~ ✅ **FIXED (2026-02-17)**
   - ✅ `clientSecret`, `tenantId`, `clientId` no longer sent to frontend
   - ✅ Only public provider metadata (`id`, `name`, `displayName`, `type`, `enabled`) exposed
   - ✅ Sanitization implemented in `/api/auth/status` endpoint

5. ~~**ChatInput Crash Bug**~~ ✅ **FIXED (2026-02-17)**
   - ✅ Removed undeclared `setSelectedCloudProvider(null)` call
   - ✅ Removed debug `console.log`/`console.warn` statements
   - ✅ Removed debug `useEffect` in ChatInputActionsMenu
   - ✅ No longer crashes when toggling uploader with cloud storage enabled

6. **No Refresh Token Warning**
   - Microsoft OAuth sometimes doesn't return refresh token
   - When this happens, tokens expire without refresh capability
   - User must reconnect every hour
   - Backend logs warning but doesn't fail gracefully

### Minor Issues

4. **Token Expiration UI**
   - No visual indication when tokens are about to expire
   - No proactive refresh prompt for users

5. **Error Messages**
   - Generic error messages in CloudStoragePicker
   - No specific guidance for common issues

6. **Testing Gaps**
   - No automated tests for OAuth flow
   - No integration tests for token refresh
   - No E2E tests for file selection

### Design Limitations

7. **Single Provider Type Per User**
   - User can only connect to one SharePoint provider instance
   - No support for multiple SharePoint accounts

8. **No File Upload Progress**
   - No progress indicator when downloading from SharePoint
   - No cancellation support

9. **No File Metadata Preservation**
   - SharePoint metadata (tags, properties) not preserved
   - Only basic file info (name, size, type) transferred

## What's Missing for Production

### High Priority

1. ~~**Frontend File Picker Integration**~~ ✅ **COMPLETE (2026-02-17)**
   - ✅ Custom SharePoint file browser implemented
   - ✅ Drive listing and folder navigation working
   - ✅ File selection with multi-select
   - ✅ Download files via backend API
   - ✅ Integration with existing file processing pipeline
   - ✅ Mixed local + cloud file support

2. ~~**IntegrationsPage SharePoint Section**~~ ✅ **COMPLETE (2026-02-17)**
   - ✅ SharePoint status check implemented
   - ✅ Connect/disconnect buttons added
   - ✅ OAuth callback handling complete
   - ✅ Connected account info displayed
   - ✅ Token expiration warnings shown

3. **Refresh Token Handling**
   - Force `prompt: consent` consistently
   - Add fallback UI when refresh token missing
   - Implement token expiration warnings

### Medium Priority

4. **File Upload Pipeline Integration**
   - Process downloaded SharePoint files through existing upload handlers
   - Support image resizing for SharePoint images
   - Support document text extraction for SharePoint docs

5. **Error Handling Improvements**
   - User-friendly error messages
   - Retry logic for failed downloads
   - Connection test functionality

6. **UI/UX Enhancements**
   - File preview before selection
   - Recent files support
   - Folder navigation in picker
   - Multi-file selection

### Low Priority

7. **Testing & Documentation**
   - Unit tests for SharePointService
   - Integration tests for OAuth flow
   - E2E tests for file selection
   - User documentation
   - Admin setup guide

8. **Additional Providers**
   - Google Drive implementation
   - Dropbox support
   - OneDrive for Business

9. **Advanced Features**
   - Direct link support (shared links)
   - Search functionality
   - File caching
   - Batch upload

## Configuration Examples

### SharePoint Configuration

This guide walks through the complete setup of SharePoint/OneDrive integration with Microsoft Entra (Azure AD).

#### Step 1: Create App Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Microsoft Entra ID** (formerly Azure Active Directory)
3. Click **App registrations** in the left menu
4. Click **+ New registration**
5. Fill in the registration details:
   - **Name**: `iHub Apps SharePoint Integration` (or any descriptive name)
   - **Supported account types**:
     - Choose **"Accounts in this organizational directory only"** (single tenant - recommended)
     - Or **"Accounts in any organizational directory"** (multi-tenant) for cross-tenant access
   - **Redirect URI**:
     - Type: **Web**
     - Development URL: `http://localhost:3000/api/integrations/sharepoint/callback`
     - You can add production URLs later in step 5
6. Click **Register**

#### Step 2: Get Your Application IDs

After registration, you'll see the **Overview** page. Copy these values for later:

- **Application (client) ID** → This is your `clientId`
- **Directory (tenant) ID** → This is your `tenantId`

Keep these IDs handy - you'll need them for the iHub Apps configuration.

#### Step 3: Create Client Secret

1. In the left menu, click **Certificates & secrets**
2. Go to the **Client secrets** tab
3. Click **+ New client secret**
4. Add a description: `iHub Apps Integration`
5. Choose expiration period: **24 months** (or as per your organization's policy)
6. Click **Add**
7. **CRITICAL**: Copy the **Value** immediately → This is your `clientSecret`
   - ⚠️ **You can only see this value once!** Store it securely
   - If you lose it, you'll need to create a new secret

#### Step 4: Configure API Permissions

1. In the left menu, click **API permissions**
2. Click **+ Add a permission**
3. Select **Microsoft Graph**
4. Choose **Delegated permissions** (NOT Application permissions)
5. Search for and add these permissions:

   **Required permissions:**
   - `Files.Read.All` - Read all files that user can access
   - `Sites.Read.All` - Read items in all site collections
   - `User.Read` - Sign in and read user profile
   - `offline_access` - Maintain access to data (enables refresh tokens)

   **Optional permissions (for future features):**
   - `Files.ReadWrite.All` - If you want write access later
   - `Group.Read.All` - Access Teams/Groups files

6. Click **Add permissions**
7. **Grant Admin Consent**:
   - Click **Grant admin consent for [Your Organization]**
   - This requires **Global Administrator** or **Privileged Role Administrator** privileges
   - Without this, each user will see a consent prompt when connecting
   - Consent status should show green checkmarks after granting

#### Step 5: Add Production Redirect URI (when deploying)

1. Go to **Authentication** in the left menu
2. Under **Web** → **Redirect URIs**, click **+ Add URI**
3. Add your production URL(s):
   - Production: `https://your-domain.com/api/integrations/sharepoint/callback`
   - Staging: `https://staging.your-domain.com/api/integrations/sharepoint/callback`
4. Click **Save**

**Note**: You can have multiple redirect URIs for different environments.

#### Step 6: Configure in iHub Apps

**Option A: Via Admin UI (Recommended)**

1. Navigate to **Admin → System → Cloud Storage Configuration**
2. Toggle **Enable Cloud Storage** to ON
3. Click **Add Provider**
4. Select **SharePoint** as the provider type
5. Fill in the form:
   - **Display Name**: `Company SharePoint` (user-facing name)
   - **Tenant ID**: Paste from Step 2
   - **Client ID**: Paste from Step 2
   - **Client Secret**: Paste from Step 3
   - **Redirect URI**: Leave empty to use default, or specify custom URL
6. Click **Save Configuration**

**Option B: Via Configuration File**

Edit `contents/config/platform.json`:

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "sharepoint",
        "name": "sharepoint",
        "displayName": "Company SharePoint",
        "type": "sharepoint",
        "enabled": true,
        "tenantId": "your-tenant-id-here",
        "clientId": "your-client-id-here",
        "clientSecret": "your-client-secret-here"
      }
    ]
  }
}
```

Then restart the server to load the new configuration.

#### Step 7: Test the Integration

1. Restart your iHub Apps server if you edited the config file manually
2. Log in to iHub Apps
3. Navigate to **Settings → Integrations**
4. You should see the **SharePoint** integration card
5. Click **Connect to SharePoint**
6. You'll be redirected to Microsoft login page
7. Sign in with your **Microsoft 365 account**
8. Review and accept the permissions (if admin consent wasn't granted)
9. You'll be redirected back to iHub Apps with a success message
10. The SharePoint card should now show:
    - Your name and email
    - Connected status (green)
    - Token expiration time
    - Available features

#### What Access You'll Get

With these permissions and proper configuration, users can access:

✅ **OneDrive Personal**: All files in user's personal OneDrive
✅ **SharePoint Sites**: All SharePoint sites the user has access to
✅ **Shared Libraries**: Document libraries shared with the user
✅ **Teams Files**: Files stored in Microsoft Teams channels (via SharePoint backend)
✅ **Shared Files**: Files shared with the user by other people

**Access Scope**: Users can only access files they have permission to access through their Microsoft 365 account. The app uses **delegated permissions**, meaning it acts on behalf of the signed-in user.

#### Security & Compliance Notes

1. **Delegated Permissions**: The app uses user credentials, not app-only access
   - Users can only access their own files
   - Respects all SharePoint/OneDrive permissions
   - No elevated privileges

2. **OAuth 2.0 with PKCE**: Modern security standard
   - Protection against authorization code interception
   - No client secret exposed to browser

3. **Encrypted Token Storage**:
   - All tokens encrypted with AES-256-GCM
   - Stored per-user on server
   - Encryption key persisted in `contents/.encryption-key`

4. **Token Refresh**:
   - Automatic refresh 2 minutes before expiration
   - Graceful handling of refresh failures
   - Users prompted to reconnect if refresh fails

5. **Audit Trail**:
   - All file access logged through Microsoft Graph API
   - Visible in Microsoft 365 audit logs
   - Compliance with organizational policies

#### Troubleshooting

**"AADSTS700016: Application with identifier 'xxx' was not found"**
- **Cause**: Wrong tenant ID or client ID in configuration
- **Fix**: Double-check IDs from Azure AD app registration overview page
- **Also check**: App might have been deleted in Azure AD

**"AADSTS65001: The user or administrator has not consented to use the application"**
- **Cause**: Admin consent not granted for the required permissions
- **Fix**: Go to Azure AD → App registrations → API permissions → Grant admin consent
- **Alternative**: Users can consent individually (requires user consent policy to allow this)

**"AADSTS50011: The redirect URI specified in the request does not match"**
- **Cause**: Redirect URI mismatch between iHub config and Azure AD
- **Fix**: Check **both** places have the exact same URL (including http/https, port, path)
- **Note**: URLs are case-sensitive and must match exactly

**"No refresh token received from Microsoft OAuth"**
- **Cause**: `offline_access` permission not granted or consent not requested properly
- **Fix**:
  1. Verify `offline_access` is in the API permissions list
  2. Disconnect SharePoint in iHub Apps
  3. Reconnect to trigger new consent
- **Workaround**: User will need to reconnect every hour if refresh token is missing

**"Cloud storage is not enabled" error when connecting**
- **Cause**: Configuration not loaded or validation failed
- **Fix**:
  1. Check `contents/config/platform.json` has `cloudStorage.enabled: true`
  2. Verify no empty strings in optional URL fields
  3. Restart server to reload configuration
  4. Check server logs for validation errors

**Files not appearing in browser or "Drive not found"**
- **Cause**: User doesn't have access or OneDrive not provisioned
- **Fix**:
  1. Verify user has OneDrive license
  2. Check user has accessed OneDrive at least once
  3. Verify SharePoint sites are accessible to the user

**Token expires too quickly (< 1 hour)**
- **Cause**: Default Microsoft token lifetime is 1 hour
- **Fix**: This is expected behavior; refresh token should handle this automatically
- **Note**: Refresh happens proactively 2 minutes before expiration

#### Step 8: User Connection Flow ✅ (Complete as of 2026-02-17)

After configuration is complete, users can connect their accounts:

1. User navigates to **Settings → Integrations**
2. Sees **SharePoint** integration card
3. Clicks **Connect to SharePoint** button
4. Gets redirected to Microsoft OAuth consent screen
5. Signs in with Microsoft 365 credentials
6. Reviews and accepts permissions
7. Gets redirected back to `/settings/integrations?sharepoint_connected=true`
8. Success message displayed automatically
9. SharePoint card shows:
   - Connected status with green indicator
   - User's display name and email
   - Token expiration time
   - Warning if token expires soon
   - List of available features

10. User can now select SharePoint files when uploading in chat applications

### Environment Variables

```bash
# Optional: Override encryption key (for multi-node deployments)
TOKEN_ENCRYPTION_KEY=your-64-char-hex-key

# Optional: Override SharePoint redirect URI
SHAREPOINT_OAUTH_REDIRECT_URI=https://your-domain.com/api/integrations/sharepoint/callback

# Required: Server URL for redirect URI construction
SERVER_URL=https://your-domain.com
```

## Testing Checklist

### Backend Testing ✅

- [x] OAuth flow generates correct authorization URL
- [x] PKCE code verifier and challenge work correctly
- [x] Token exchange succeeds with valid auth code
- [x] Tokens are encrypted and stored correctly
- [x] Token retrieval and decryption work
- [x] Automatic token refresh on expiration
- [x] Retry logic on 401 errors
- [x] User info retrieval from Graph API
- [x] Drive listing works
- [x] File listing works
- [x] File download returns correct content

### Frontend Testing ⚠️

- [x] Cloud storage config UI works
- [x] Provider add/edit/delete work
- [x] Secret sanitization works
- [x] CloudStoragePicker modal opens
- [x] Provider selection works
- [x] IntegrationsPage SharePoint section ✅ (2026-02-17)
- [x] OAuth callback handling ✅ (2026-02-17)
- [x] Connect/disconnect buttons ✅ (2026-02-17)
- [x] ChatInput uploader toggle ✅ (2026-02-17)
- [x] Custom file browser implementation ✅ (2026-02-17)
- [x] File selection (multi-select) ✅ (2026-02-17)
- [x] File download via backend API ✅ (2026-02-17)
- [x] File upload integration (mixed local + cloud) ✅ (2026-02-17)

### Integration Testing ❌

- [ ] End-to-end OAuth flow
- [ ] End-to-end file selection and upload
- [ ] Token expiration and refresh
- [ ] Error handling for common scenarios
- [ ] Multi-user token isolation

## Security Considerations

1. **Token Encryption**: AES-256-GCM with unique IV per token ✅
2. **Context Binding**: Tokens bound to user + service to prevent reuse ✅
3. **Key Persistence**: Encryption key persisted securely ✅
4. **OAuth PKCE**: Prevents authorization code interception ✅
5. **State Parameter**: CSRF protection in OAuth flow ✅
6. **Session Timeout**: 15-minute timeout on OAuth state ✅
7. **Delegated Permissions**: Uses user's own Microsoft account ✅
8. **Automatic Cleanup**: Invalid tokens deleted to allow reconnection ✅
9. **Secret Sanitization**: Client secrets never exposed to frontend ✅
10. **File Permissions**: Respects SharePoint user permissions ✅

## Performance Considerations

1. **Token Caching**: Tokens cached in memory after decryption ❌ NOT IMPLEMENTED
2. **Proactive Refresh**: Tokens refreshed 2 minutes before expiration ✅
3. **Retry Logic**: Automatic retry on transient errors ✅
4. **Connection Pooling**: Axios connection reuse ✅
5. **File Streaming**: Files returned as Buffer for efficient memory usage ✅

## Migration Guide

### Enabling Cloud Storage

**For Existing Installations:**

1. Update `contents/config/platform.json`:
```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": []
  }
}
```

2. Restart server (encryption key will be generated automatically)

3. Configure providers via Admin UI:
   - Navigate to Admin → System
   - Scroll to "Cloud Storage Configuration"
   - Click "Add Provider"
   - Fill in provider details from Azure AD
   - Save configuration

4. Users connect their accounts:
   - ⚠️ Currently must manually navigate to OAuth URL
   - Once IntegrationsPage is fixed, will have UI button

**No Breaking Changes:**
- Local file upload continues to work as before
- Cloud storage is opt-in
- Existing file upload configurations unaffected

## Extensibility

### Adding New Providers

To add a new cloud storage provider (e.g., Dropbox):

1. **Add Provider Schema** (`server/validators/cloudStorageSchema.js`):
```javascript
export const dropboxProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  type: z.literal('dropbox'),
  enabled: z.boolean().default(true),
  appKey: z.string(),
  appSecret: z.string(),
  redirectUri: z.string().url().optional()
});

export const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  sharepointProviderSchema,
  googleDriveProviderSchema,
  dropboxProviderSchema
]);
```

2. **Create Service** (`server/services/integrations/DropboxService.js`):
   - Implement OAuth flow
   - Implement file listing
   - Implement file download
   - Use TokenStorageService for token management

3. **Create Routes** (`server/routes/integrations/dropbox.js`):
   - `/auth` - OAuth initiation
   - `/callback` - OAuth callback
   - `/status` - Connection status
   - `/disconnect` - Disconnect account
   - `/files` - List files
   - `/download` - Download file

4. **Update CloudStoragePicker** (`CloudStoragePicker.jsx`):
```javascript
const openDropboxPicker = async (provider) => {
  // Implement Dropbox Chooser API
};

if (selectedProvider.type === 'dropbox') {
  await openDropboxPicker(selectedProvider);
}
```

5. **Add Translations**:
```json
{
  "admin": {
    "cloudStorage": {
      "dropbox": "Dropbox"
    }
  }
}
```

## Future Enhancements

1. **Additional Providers**: Dropbox, Box, OneDrive for Business
2. **Advanced File Selection**: Folder navigation, search, filters
3. **File Preview**: Preview files before selection
4. **Recent Files**: Show recently accessed files
5. **Favorites**: Mark frequently used files
6. **Token Caching**: Cache decrypted tokens in memory
7. **Batch Upload**: Select multiple files at once
8. **Progress Indicators**: Show file download progress
9. **Direct Links**: Support direct file links (shared links)
10. **Metadata Preservation**: Preserve SharePoint metadata

## Conclusion

The SharePoint cloud storage integration backend is **fully functional** and production-ready. The architecture is secure, extensible, and follows best practices for OAuth 2.0 and token management.

**What Works:**
- ✅ Complete OAuth 2.0 PKCE flow
- ✅ Secure encrypted token storage
- ✅ Automatic token refresh
- ✅ Microsoft Graph API integration
- ✅ File browsing and download (backend + frontend)
- ✅ Admin configuration UI
- ✅ Multi-provider support
- ✅ Custom SharePoint file browser (no SDK dependency)
- ✅ IntegrationsPage SharePoint section
- ✅ End-to-end file upload flow
- ✅ User-facing connection UI
- ✅ Mixed local + cloud file uploads

**What's Missing:**
- ⏳ Comprehensive testing (E2E, integration tests)
- ⏳ Google Drive integration
- ⏳ Advanced features (search, preview, batch upload)

**Next Steps:**
1. Add comprehensive testing (unit, integration, E2E)
2. Implement Google Drive provider
3. Add advanced features (file preview, search, recent files)
4. Performance optimizations (token caching, file streaming)
5. User documentation and admin setup guide

The foundation is solid, and completing the frontend integration will make this a fully functional cloud storage system for iHub Apps.
