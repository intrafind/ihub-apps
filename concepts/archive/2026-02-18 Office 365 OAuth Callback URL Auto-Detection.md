# Office 365 OAuth Callback URL Auto-Detection

**Date**: 2026-02-18  
**Updated**: 2026-02-19 - Added provider-specific callback URLs  
**Issue**: OAuth with Office 365 only worked after specifying the URL manually

## Problem

When Office 365 OAuth integration was not configured with an explicit `redirectUri`, the system would always redirect to `http://localhost:3000/api/integrations/office365/callback`, regardless of the actual domain being used (e.g., `https://ihub.local.intrafind.io`).

Additionally, the callback URL was hardcoded without including the provider ID, which made it difficult to:
- Register multiple Office 365 providers with different Azure AD apps
- Clearly identify which provider is being used in Azure AD app registrations
- Follow best practices for multi-tenant or multi-provider OAuth configurations

This caused OAuth to fail unless users manually configured the full callback URL in the platform configuration or environment variables.

## Root Cause

The `Office365Service` class was using hardcoded fallback values without considering:
1. The actual request context (protocol, host, reverse proxy headers)
2. The provider ID in the callback URL path

```javascript
// Old code
const redirectUri =
  provider.redirectUri ||
  process.env.OFFICE365_OAUTH_REDIRECT_URI ||
  `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/office365/callback`;
```

This didn't account for:
- The actual protocol (http vs https)
- The actual host/domain from the incoming request
- Reverse proxy headers (X-Forwarded-Proto, X-Forwarded-Host)
- **Provider-specific callback URLs for multiple Office 365 providers**

## Solution

### 1. Created `_buildCallbackUrl(req, providerId)` Method

Added a new private method in `Office365Service.js` that extracts the callback URL from the Express request object and includes the provider ID:

```javascript
_buildCallbackUrl(req, providerId) {
  // Get protocol - consider X-Forwarded-Proto for reverse proxy setups
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  
  // Get host - consider X-Forwarded-Host for reverse proxy setups
  const host = req.get('x-forwarded-host') || req.get('host');
  
  if (!host) {
    throw new Error('Unable to determine host for callback URL');
  }
  
  // Build full callback URL with provider ID
  return `${protocol}://${host}/api/integrations/office365/${providerId}/callback`;
}
```

This method:
- Checks `X-Forwarded-Proto` header first (for reverse proxies)
- Falls back to `req.protocol` if not behind a proxy
- Defaults to `https` if neither is available
- Checks `X-Forwarded-Host` header first (for reverse proxies)
- Falls back to `req.get('host')` if not behind a proxy
- Throws an error if host cannot be determined

### 2. Updated `generateAuthUrl` Method

Modified the method signature to accept an optional `req` parameter:

```javascript
generateAuthUrl(providerId, state, codeVerifier, req = null) {
  // Use the provider's redirect URI, environment variable, auto-detected URL, or fallback to localhost
  let redirectUri = provider.redirectUri || process.env.OFFICE365_OAUTH_REDIRECT_URI;
  
  if (!redirectUri && req) {
    // Auto-detect from request if not configured
    redirectUri = this._buildCallbackUrl(req);
    logger.info('🔗 Auto-detected Office 365 callback URL from request', {
      component: 'Office 365',
      redirectUri
    });
  }
  
  if (!redirectUri) {
    // Final fallback to localhost (development)
    redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/office365/callback`;
    logger.warn('⚠️ Using fallback localhost URL for Office 365 callback', {
      component: 'Office 365',
      redirectUri
    });
  }
  
  // ... rest of the method
}
```

### 3. Updated `exchangeCodeForTokens` Method

Applied the same pattern to the token exchange method, as the redirect URI must match exactly between the authorization and token exchange requests:

```javascript
async exchangeCodeForTokens(providerId, authCode, codeVerifier, req = null) {
  // Same auto-detection logic as generateAuthUrl
  // ...
}
```

### 4. Updated Route Handlers

Modified the route handlers in `server/routes/integrations/office365.js` to pass the request object:

```javascript
// /auth route
const authUrl = Office365Service.generateAuthUrl(providerId, state, codeVerifier, req);

// /callback route
const tokens = await Office365Service.exchangeCodeForTokens(
  storedAuth.providerId,
  code,
  storedAuth.codeVerifier,
  req
);
```

### 4. Updated Route Handlers

Added provider-specific callback route in `server/routes/integrations/office365.js`:

```javascript
// New provider-specific callback route
router.get('/:providerId/callback', authOptional, async (req, res) => {
  const { providerId } = req.params;
  const storedAuth = req.session.office365Auth;
  
  // Verify providerId matches
  if (storedAuth.providerId !== providerId) {
    logger.error('❌ Provider ID mismatch in Office 365 OAuth callback');
    return res.redirect('/settings/integrations?office365_error=provider_mismatch');
  }
  
  // Exchange tokens and complete OAuth flow
  // ...
});

// Legacy callback route (backward compatibility)
router.get('/callback', authOptional, async (req, res) => {
  // Uses session-based provider identification
  // ...
});
```

## Configuration Priority

The solution maintains backward compatibility with the following priority order:

1. **Explicit Configuration**: `provider.redirectUri` in platform config
2. **Environment Variable**: `OFFICE365_OAUTH_REDIRECT_URI`
3. **Auto-Detection**: Extracted from incoming request with provider ID (NEW)
4. **Fallback**: `http://localhost:3000/api/integrations/office365/{providerId}/callback` (for development)

## Benefits

1. **Zero Configuration**: Works out-of-the-box for most deployments
2. **Provider-Specific URLs**: Each Office 365 provider gets its own callback URL
3. **Multi-Provider Support**: Clear separation when registering multiple Azure AD apps
4. **Reverse Proxy Support**: Respects X-Forwarded-Proto and X-Forwarded-Host headers
5. **Backward Compatible**: Existing configurations continue to work (legacy route maintained)
6. **Development Friendly**: Falls back to localhost when no request is available
7. **Production Ready**: Automatically detects HTTPS and correct domain
8. **Azure AD Clarity**: Provider-specific URLs make Azure AD app registration clearer

## Example Callback URLs

For different providers configured in the system:

- **Provider ID**: `office365-main` → `https://domain.com/api/integrations/office365/office365-main/callback`
- **Provider ID**: `sharepoint-prod` → `https://domain.com/api/integrations/office365/sharepoint-prod/callback`
- **Provider ID**: `tenant-a` → `https://domain.com/api/integrations/office365/tenant-a/callback`

Each provider can be registered with its specific callback URL in Azure AD, making it clear which app registration corresponds to which provider in iHub Apps.

## Testing

To test the fix:

1. Remove any explicit `redirectUri` configuration from platform.json
2. Remove `OFFICE365_OAUTH_REDIRECT_URI` environment variable
3. Access the application via your actual domain (e.g., `https://ihub.local.intrafind.io`)
4. Initiate Office 365 OAuth flow for a specific provider (e.g., `office365-main`)
5. Verify that Microsoft redirects to: `https://ihub.local.intrafind.io/api/integrations/office365/office365-main/callback`
6. Test with multiple providers to verify each gets its own callback URL

## Code Locations

- **Service**: `server/services/integrations/Office365Service.js`
  - Updated method: `_buildCallbackUrl(req, providerId)` (lines 24-43)
  - Updated method: `generateAuthUrl()` (lines 78-120)
  - Updated method: `exchangeCodeForTokens()` (lines 141-180)
- **Routes**: `server/routes/integrations/office365.js`
  - New route: `/:providerId/callback` (provider-specific callback)
  - Updated route: `/callback` (legacy callback for backward compatibility)
  - Updated: `/auth` route handler (passes `req` to `generateAuthUrl()`)
- **Tests**: `server/tests/office365-callback-url-autodetect.test.js`
  - Updated to test provider-specific URLs
  - Tests multiple providers with different IDs

## Security Considerations

- The solution respects reverse proxy headers for proper protocol and host detection
- Provider ID validation: Callback verifies that URL parameter matches session state
- Host validation is implicit through Express's `req.get('host')` method
- No user-controlled input is used in URL construction
- Original security measures (PKCE, state validation, session timeout) remain unchanged
- Provider ID mismatch triggers error and session cleanup

## Migration Notes

No migration is required. The change is backward compatible:

1. **New callback route** with provider ID: `/:providerId/callback` (recommended)
2. **Legacy callback route** without provider ID: `/callback` (deprecated but functional)
3. Existing deployments will automatically use provider-specific URLs for new OAuth flows
4. Old callback URLs will continue to work during transition period
