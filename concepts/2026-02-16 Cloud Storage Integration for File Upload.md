# Cloud Storage Integration for File Upload

**Date:** 2026-02-16  
**Feature:** SharePoint and Cloud Storage Integration for File Uploads  
**Status:** Phase 1-3 Complete, Phase 4-5 Pending

## Overview

This feature adds cloud storage integration to iHub Apps, allowing users to select files directly from cloud storage providers (SharePoint, Google Drive) instead of requiring them to download files locally first. The implementation is designed to be extensible, supporting multiple providers and multiple instances of the same provider type.

## Business Requirements

1. **SharePoint Integration**: Users should be able to select files from SharePoint directly
2. **Admin Configuration**: Administrators must be able to enable/disable and configure cloud storage providers
3. **Extensibility**: The architecture must support adding other providers (Google Drive, Dropbox, etc.) in the future
4. **Upload Integration**: Cloud storage selection should be seamlessly integrated into existing file upload flows
5. **Backward Compatibility**: Local file upload must remain the default option

## Architecture

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
        "siteUrl": "https://yourcompany.sharepoint.com/sites/yoursite",
        "driveId": "drive-id",
        "redirectUri": "https://your-app.com/auth/callback"
      }
    ]
  }
}
```

### Schema Design

**Provider Schema** (`server/validators/cloudStorageSchema.js`):
- Uses Zod discriminated union for type-safe provider configurations
- Supports multiple provider types: `sharepoint`, `googledrive`
- Each provider type has its own required and optional fields
- Extensible design allows adding new provider types easily

### Security

**Secret Management:**
- Client secrets are sanitized in API responses (replaced with `***REDACTED***`)
- Environment variable placeholders (e.g., `${CLIENT_SECRET}`) are preserved
- Secrets are restored when updating configuration to prevent accidental overwrites
- Similar pattern to OIDC provider secret handling

## Implementation

### Phase 1: Backend Configuration ✅

**Files Created/Modified:**
- `server/validators/cloudStorageSchema.js` - Provider schemas
- `server/validators/platformConfigSchema.js` - Platform config integration
- `server/routes/admin/configs.js` - Secret sanitization and restoration
- `shared/i18n/en.json`, `shared/i18n/de.json` - Translations

**Key Features:**
- Zod validation for provider configurations
- Support for SharePoint and Google Drive provider types
- Secret sanitization similar to OIDC providers
- Comprehensive i18n support (English/German)

### Phase 2: Frontend Admin UI ✅

**Files Created/Modified:**
- `client/src/features/admin/components/CloudStorageConfig.jsx` - Provider management UI
- `client/src/features/admin/pages/AdminSystemPage.jsx` - Integration into admin

**Key Features:**
- Enable/disable toggle for cloud storage
- Provider list with add, edit, delete operations
- Modal editor for provider configuration
- Provider-specific fields (SharePoint vs Google Drive)
- Real-time validation
- Success/error messaging

**Admin UI Location:**
- Accessible via: Admin → System → Cloud Storage Configuration
- Appears after SSL Configuration section

### Phase 3: File Upload Integration ✅

**Files Created/Modified:**
- `client/src/features/upload/components/CloudStoragePicker.jsx` - Provider selection modal
- `client/src/features/upload/components/UnifiedUploader.jsx` - Integration into upload flow

**Key Features:**
- "Upload from cloud" button appears when cloud storage is enabled
- Provider selection modal
- Auto-selects provider if only one is configured
- Placeholder structure for SharePoint/Google Drive SDKs
- Graceful degradation when cloud storage is disabled

**User Flow:**
1. User opens file upload dialog
2. Sees two options: "Upload from device" and "Upload from cloud"
3. Clicks "Upload from cloud"
4. Selects provider (if multiple configured)
5. Provider-specific file picker launches (placeholder for now)
6. Selected files are processed and uploaded

### Phase 4: SharePoint Authentication & API (Pending)

**Planned Implementation:**

**SharePoint Integration:**
- Use Microsoft Graph API
- Implement OneDrive File Picker SDK
- OAuth 2.0 authentication flow
- Required permissions: `Files.Read`, `Sites.Read.All`

**Backend Routes (to be created):**
- `POST /api/cloud-storage/sharepoint/authorize` - Initiate OAuth flow
- `GET /api/cloud-storage/sharepoint/callback` - OAuth callback handler
- `POST /api/cloud-storage/sharepoint/files` - Fetch file content
- `GET /api/cloud-storage/sharepoint/token` - Get access token

**Frontend Integration:**
```javascript
// Example SharePoint picker implementation
const pickerOptions = {
  clientId: provider.clientId,
  action: 'share',
  multiSelect: false,
  advanced: {
    redirectUri: provider.redirectUri || window.location.origin
  },
  success: (files) => {
    // Process selected files
    onFileSelect(files);
    onClose();
  },
  cancel: () => {
    onClose();
  },
  error: (error) => {
    setError(error.message);
  }
};

// Initialize and launch picker
OneDrive.open(pickerOptions);
```

**Google Drive Integration:**
- Use Google Picker API
- OAuth 2.0 authentication
- Required scopes: `https://www.googleapis.com/auth/drive.readonly`

### Phase 5: Documentation & Testing (Pending)

**To Do:**
- [ ] Create admin guide for configuring SharePoint
- [ ] Add example configurations
- [ ] Create user guide for cloud file selection
- [ ] Test with actual SharePoint instance
- [ ] Verify Google Drive extensibility
- [ ] Add error handling documentation

## Configuration Examples

### SharePoint Configuration

**Step 1: Register App in Azure AD**
1. Go to Azure Portal → Azure Active Directory → App registrations
2. Click "New registration"
3. Name: "iHub Apps SharePoint Integration"
4. Supported account types: "Accounts in this organizational directory only"
5. Redirect URI: Web - `https://your-ihub-app.com/auth/callback`

**Step 2: Configure API Permissions**
1. Go to API permissions
2. Add permission → Microsoft Graph → Delegated permissions
3. Add: `Files.Read`, `Sites.Read.All`
4. Grant admin consent

**Step 3: Create Client Secret**
1. Go to Certificates & secrets
2. New client secret
3. Description: "iHub Apps Integration"
4. Expires: 24 months (or as per policy)
5. Copy the secret value immediately

**Step 4: Configure in iHub Apps**
1. Go to Admin → System → Cloud Storage Configuration
2. Enable Cloud Storage
3. Add Provider:
   - Type: Microsoft SharePoint
   - Display Name: "Company SharePoint"
   - Tenant ID: [from Azure AD]
   - Client ID: [from app registration]
   - Client Secret: [from step 3]
   - Site URL: (optional) Specific SharePoint site
   - Drive ID: (optional) Specific document library

### Google Drive Configuration

**Step 1: Create Project in Google Cloud Console**
1. Go to Google Cloud Console
2. Create new project: "iHub Apps Drive Integration"
3. Enable Google Drive API

**Step 2: Create OAuth Credentials**
1. Go to APIs & Services → Credentials
2. Create OAuth 2.0 Client ID
3. Application type: Web application
4. Authorized redirect URIs: `https://your-ihub-app.com/auth/callback`

**Step 3: Configure in iHub Apps**
1. Go to Admin → System → Cloud Storage Configuration
2. Add Provider:
   - Type: Google Drive
   - Display Name: "Google Drive"
   - Client ID: [from Google Cloud]
   - Client Secret: [from Google Cloud]

## Technical Details

### File Processing Flow

**Current (Local Upload):**
1. User selects file from device
2. File is read in browser using FileReader API
3. Content is processed (images resized, documents extracted)
4. Processed content sent to AI model

**Future (Cloud Upload):**
1. User selects file from cloud storage
2. Browser receives file metadata and download URL
3. Backend fetches file content using provider API
4. Content is processed server-side
5. Processed content sent to AI model

### Data Flow

```
User Action → CloudStoragePicker
           ↓
      Provider Selection
           ↓
      OAuth Flow (Future)
           ↓
      Provider SDK (Future)
           ↓
      File Metadata
           ↓
   Backend File Fetch (Future)
           ↓
    File Processing
           ↓
     AI Model Input
```

### Security Considerations

1. **Client Secrets**: Stored encrypted in configuration, never exposed to frontend
2. **OAuth Tokens**: Managed server-side, short-lived access tokens
3. **User Context**: Files accessed using user's OAuth credentials, not service account
4. **Permissions**: Respects SharePoint/Drive permissions
5. **Secret Rotation**: Supports updating client secrets without downtime

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

// Update union
export const cloudStorageProviderSchema = z.discriminatedUnion('type', [
  sharepointProviderSchema,
  googleDriveProviderSchema,
  dropboxProviderSchema  // Add new provider
]);
```

2. **Update CloudStoragePicker** (`CloudStoragePicker.jsx`):
```javascript
// Add Dropbox handler
const openDropboxPicker = async (provider) => {
  // Implement Dropbox picker using Chooser API
};

// Add to switch statement
if (selectedProvider.type === 'dropbox') {
  await openDropboxPicker(selectedProvider);
}
```

3. **Add Translations**:
```json
{
  "admin": {
    "cloudStorage": {
      "dropbox": "Dropbox"
    }
  }
}
```

## Testing Checklist

### Admin Configuration
- [ ] Enable/disable cloud storage globally
- [ ] Add SharePoint provider
- [ ] Add Google Drive provider
- [ ] Edit existing provider
- [ ] Delete provider
- [ ] Multiple providers of same type
- [ ] Secret sanitization works correctly
- [ ] Configuration persists across restarts

### File Upload Integration
- [ ] "Upload from cloud" button appears when enabled
- [ ] Button hidden when cloud storage disabled
- [ ] Provider selection modal works
- [ ] Auto-selection with single provider
- [ ] Error handling for no providers
- [ ] Cancel/close modal works
- [ ] Integration with existing upload flow

### SharePoint Integration (Future)
- [ ] OAuth flow completes successfully
- [ ] File picker opens correctly
- [ ] File selection works
- [ ] Multiple file selection (if enabled)
- [ ] File content fetches correctly
- [ ] Error handling for auth failures
- [ ] Token refresh works

## Known Limitations

1. **Phase 4 Not Implemented**: SharePoint/Google Drive file pickers are placeholders
2. **No Backend Routes**: File fetching from cloud providers not yet implemented
3. **No OAuth Flow**: Authentication flow not yet implemented
4. **Client-Side Only**: Current implementation is UI-only, no actual file access
5. **No File Caching**: Each selection requires re-authentication (to be addressed)

## Future Enhancements

1. **Additional Providers**: Dropbox, Box, OneDrive for Business
2. **Folder Navigation**: Browse SharePoint folders in picker
3. **Search**: Search for files in cloud storage
4. **Recent Files**: Show recently accessed files
5. **Favorites**: Mark frequently used files
6. **Token Caching**: Cache OAuth tokens per user
7. **Batch Upload**: Select multiple files at once
8. **Progress Indicators**: Show file download progress
9. **File Preview**: Preview files before selection
10. **Direct Links**: Support direct file links (shared links)

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

2. Restart server (if using environment variables for secrets)

3. Configure providers via Admin UI:
   - Navigate to Admin → System
   - Scroll to "Cloud Storage Configuration"
   - Click "Add Provider"
   - Fill in provider details
   - Save configuration

**No Breaking Changes:**
- Local file upload continues to work as before
- Cloud storage is opt-in
- Existing file upload configurations unaffected

## Related Files

### Backend
- `server/validators/cloudStorageSchema.js` - Provider schemas
- `server/validators/platformConfigSchema.js` - Platform integration
- `server/routes/admin/configs.js` - Admin API routes

### Frontend Components
- `client/src/features/admin/components/CloudStorageConfig.jsx` - Admin UI
- `client/src/features/upload/components/CloudStoragePicker.jsx` - File picker
- `client/src/features/upload/components/UnifiedUploader.jsx` - Upload integration

### Translations
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations

### Admin Pages
- `client/src/features/admin/pages/AdminSystemPage.jsx` - Admin page integration

## Conclusion

This implementation provides a solid foundation for cloud storage integration in iHub Apps. The architecture is extensible, secure, and user-friendly. Phase 1-3 are complete and ready for use in the admin UI. Phase 4 (actual SharePoint/Google Drive integration) requires backend API implementation and OAuth flow, which can be completed in a future iteration.

The design decisions prioritize:
- **Security**: Secrets properly managed, OAuth for user authentication
- **Extensibility**: Easy to add new providers
- **UX**: Seamless integration with existing upload flow
- **Backward Compatibility**: No breaking changes to existing functionality
