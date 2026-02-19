# OAuth Return URL After Integration Callback

**Date**: 2026-02-18  
**Status**: Implemented  
**Last Updated**: 2026-02-19 (Added provider-specific session keys)  
**Related Issue**: [Issue #TBD] We should return to the App after Integration Callback

## Problem Statement

When a user clicks on a cloud storage provider or JIRA integration to connect via OAuth, the OAuth flow is initiated. After successful authentication, the user was always redirected back to the integrations page (`/settings/integrations`), regardless of where they initiated the OAuth flow from.

This created a poor user experience, especially when users were:
- In the middle of uploading a file from an app (chat interface)
- Trying to use cloud storage from the apps page
- Working in any other context that required OAuth authentication

## Solution

Implemented a return URL mechanism that redirects users back to the original page after completing the OAuth flow, with support for multiple concurrent OAuth providers.

### Key Features

1. **Provider-Specific Session Keys**: Each OAuth provider uses a unique session key to prevent conflicts
   - Office 365: `oauth_office365_{providerId}` - Supports multiple Office 365 provider configurations
   - JIRA: `oauth_jira` - Single provider architecture
2. **Return URL Storage**: The original page URL is stored server-side in the session
3. **State-Based Matching**: OAuth callbacks match the state parameter to find the correct session
4. **Global URL Cleanup**: Client-side hook removes OAuth query parameters after redirect

### Implementation Details

#### Server-Side Changes

**1. OAuth Initiation (Office 365 & JIRA)**

Both `/api/integrations/office365/auth` and `/api/integrations/jira/auth` endpoints now:
- Accept an optional `returnUrl` query parameter
- Store the `returnUrl` in the session alongside other OAuth data using provider-specific keys
- Default to `/settings/integrations` if no return URL is provided

**Office 365 - Multiple Provider Support:**
```javascript
// Example: Office 365 with dynamic session key per provider
const sessionKey = `oauth_office365_${providerId}`;
req.session[sessionKey] = {
  state,
  codeVerifier,
  providerId,
  userId: req.user?.id || 'fallback-user',
  returnUrl: returnUrl || '/settings/integrations',
  timestamp: Date.now()
};
```

This allows multiple Office 365 providers (e.g., "Company SharePoint", "Partner SharePoint") to have concurrent OAuth flows without session conflicts.

**JIRA - Single Provider:**
```javascript
// Example: JIRA with consistent session key
const sessionKey = 'oauth_jira';
req.session[sessionKey] = {
  state,
  codeVerifier,
  userId: req.user?.id || 'fallback-user',
  returnUrl: returnUrl || '/settings/integrations',
  timestamp: Date.now()
};
```

**2. OAuth Callback (Office 365 & JIRA)**

Both `/api/integrations/office365/callback` and `/api/integrations/jira/callback` endpoints now:
- Search session for the matching OAuth flow using the state parameter
- Retrieve the stored `returnUrl` from the matched session
- Use the return URL for all redirects (success and error cases)
- Properly append query parameters to the return URL (handling existing query strings)
- Clean up the session after completion

**Office 365 Callback - State-Based Lookup:**
```javascript
// Find the session key that matches the state parameter
let storedAuth = null;
let sessionKey = null;

if (req.session) {
  // Look for any oauth_office365_* keys in the session
  for (const key of Object.keys(req.session)) {
    if (key.startsWith('oauth_office365_') && req.session[key]?.state === state) {
      storedAuth = req.session[key];
      sessionKey = key;
      break;
    }
  }
}

// Use the stored return URL
const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
const separator = returnUrl.includes('?') ? '&' : '?';

// Clean up session after use
if (sessionKey) {
  delete req.session[sessionKey];
}

// Redirect on success or error
res.redirect(`${returnUrl}${separator}office365_connected=true`);
```

**JIRA Callback - Direct Lookup:**
```javascript
// Direct lookup with consistent key
const sessionKey = 'oauth_jira';
const storedAuth = req.session?.[sessionKey];
const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
const separator = returnUrl.includes('?') ? '&' : '?';

// Clean up session
delete req.session[sessionKey];

// Redirect
res.redirect(`${returnUrl}${separator}jira_connected=true`);
```

#### Client-Side Changes

**1. Office365FileBrowser Component**

Updated the `handleConnect` function to pass the current page path as the return URL:

```javascript
const handleConnect = () => {
  // Get current page path as return URL
  const returnUrl = window.location.pathname + window.location.search;
  const authUrl = `/api/integrations/${provider.type}/auth?providerId=${encodeURIComponent(provider.id)}&returnUrl=${encodeURIComponent(returnUrl)}`;
  window.location.href = authUrl;
};
```

**2. IntegrationsPage Component**

Updated both `handleConnect` (JIRA) and `handleCloudConnect` (cloud providers) functions:

```javascript
// JIRA
const returnUrl = window.location.pathname + window.location.search;
window.location.href = `/api/integrations/jira/auth?returnUrl=${encodeURIComponent(returnUrl)}`;

// Cloud Providers
const returnUrl = window.location.pathname + window.location.search;
window.location.href = `/api/integrations/${provider.type}/auth?providerId=${encodeURIComponent(provider.id)}&returnUrl=${encodeURIComponent(returnUrl)}`;
```

### Key Files Modified

#### Server Files
- `server/routes/integrations/office365.js`
  - Updated `/auth` endpoint to accept and store `returnUrl`
  - Updated `/callback` endpoint to redirect to stored return URL
  - Updated all error redirects to use return URL

- `server/routes/integrations/jira.js`
  - Updated `/auth` endpoint to accept and store `returnUrl`
  - Updated `/callback` endpoint to redirect to stored return URL
  - Updated all error redirects to use return URL

#### Client Files
- `client/src/features/upload/components/Office365FileBrowser.jsx`
  - Updated `handleConnect` to pass current URL as return URL
  - Removed old sessionStorage approach

- `client/src/features/settings/pages/IntegrationsPage.jsx`
  - Updated `handleConnect` (JIRA) to pass current URL as return URL
  - Updated `handleCloudConnect` to pass current URL as return URL

## Security Considerations

1. **Session-Based Storage**: Return URL is stored server-side in the session, not passed through the OAuth redirect chain
2. **CSRF Protection**: Existing CSRF protection (state parameter) remains unchanged
3. **URL Validation**: Return URLs are internal paths within the application
4. **Query Parameter Handling**: Properly handles existing query parameters in return URLs
5. **Provider Isolation**: Each OAuth provider uses a unique session key to prevent conflicts between concurrent flows
6. **State-Based Matching**: Callbacks match the state parameter to find the correct session, preventing session confusion attacks

## Multiple Provider Support

The system now supports multiple Office 365 providers with concurrent OAuth flows:

**Configuration Example:**
```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "office365-company",
        "displayName": "Company SharePoint",
        "type": "office365",
        "enabled": true,
        "tenantId": "company-tenant-id",
        "clientId": "company-client-id",
        "clientSecret": "company-secret"
      },
      {
        "id": "office365-partner",
        "displayName": "Partner SharePoint",
        "type": "office365",
        "enabled": true,
        "tenantId": "partner-tenant-id",
        "clientId": "partner-client-id",
        "clientSecret": "partner-secret"
      }
    ]
  }
}
```

**Session Keys:**
- User connecting to "Company SharePoint": Session key = `oauth_office365_office365-company`
- User connecting to "Partner SharePoint": Session key = `oauth_office365_office365-partner`
- Both can be in OAuth flow simultaneously without conflicts

## Backward Compatibility

- If no `returnUrl` is provided, the system defaults to `/settings/integrations`
- Existing OAuth flows continue to work without changes
- Error handling maintains the same behavior with improved UX

## Testing Scenarios

1. **From Integrations Page**:
   - User clicks "Connect" on Office 365 or JIRA
   - After OAuth, user returns to integrations page (existing behavior)

2. **From Apps Page (Chat Interface)**:
   - User tries to upload from cloud storage
   - User clicks "Connect to Office 365"
   - After OAuth, user returns to the app they were using

3. **Error Handling**:
   - OAuth errors redirect back to the original page with error message
   - Session timeouts redirect to original page with appropriate error

## Benefits

- **Improved User Experience**: Users return to where they were working
- **Reduced Context Switching**: No need to navigate back to the app after connecting
- **Consistent Behavior**: Works for both cloud storage and JIRA integrations
- **Error Recovery**: Errors are displayed in the context where the user initiated the OAuth flow

## Future Enhancements

1. Consider adding return URL validation to ensure it's a valid internal path
2. Add return URL support for any future OAuth integrations
3. Consider storing additional context in the session (e.g., selected file before OAuth)
