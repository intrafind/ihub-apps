# OAuth Return URL After Integration Callback

**Date**: 2026-02-18  
**Status**: Implemented  
**Related Issue**: [Issue #TBD] We should return to the App after Integration Callback

## Problem Statement

When a user clicks on a cloud storage provider or JIRA integration to connect via OAuth, the OAuth flow is initiated. After successful authentication, the user was always redirected back to the integrations page (`/settings/integrations`), regardless of where they initiated the OAuth flow from.

This created a poor user experience, especially when users were:
- In the middle of uploading a file from an app (chat interface)
- Trying to use cloud storage from the apps page
- Working in any other context that required OAuth authentication

## Solution

Implemented a return URL mechanism that redirects users back to the original page after completing the OAuth flow.

### Implementation Details

#### Server-Side Changes

**1. OAuth Initiation (Office 365 & JIRA)**

Both `/api/integrations/office365/auth` and `/api/integrations/jira/auth` endpoints now:
- Accept an optional `returnUrl` query parameter
- Store the `returnUrl` in the session alongside other OAuth data
- Default to `/settings/integrations` if no return URL is provided

```javascript
// Example: Office 365
req.session.office365Auth = {
  state,
  codeVerifier,
  providerId,
  userId: req.user?.id || 'fallback-user',
  returnUrl: returnUrl || '/settings/integrations',  // NEW
  timestamp: Date.now()
};
```

**2. OAuth Callback (Office 365 & JIRA)**

Both `/api/integrations/office365/callback` and `/api/integrations/jira/callback` endpoints now:
- Retrieve the stored `returnUrl` from session early in the callback process
- Use the return URL for all redirects (success and error cases)
- Properly append query parameters to the return URL (handling existing query strings)

```javascript
// Get return URL early for error redirects
const returnUrl = req.session?.office365Auth?.returnUrl || '/settings/integrations';
const separator = returnUrl.includes('?') ? '&' : '?';

// Redirect on success or error
res.redirect(`${returnUrl}${separator}office365_connected=true`);
res.redirect(`${returnUrl}${separator}office365_error=${encodeURIComponent(error.message)}`);
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
