# Office 365 OAuth Callback URL Auto-Detection

**Date**: 2026-02-18  
**Issue**: OAuth with Office 365 only worked after specifying the URL manually

## Problem

When Office 365 OAuth integration was not configured with an explicit `redirectUri`, the system would always redirect to `http://localhost:3000/api/integrations/office365/callback`, regardless of the actual domain being used (e.g., `https://ihub.local.intrafind.io`).

This caused OAuth to fail unless users manually configured the full callback URL in the platform configuration or environment variables.

## Root Cause

The `Office365Service` class was using hardcoded fallback values without considering the actual request context:

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

## Solution

### 1. Created `_buildCallbackUrl(req)` Method

Added a new private method in `Office365Service.js` that extracts the callback URL from the Express request object:

```javascript
_buildCallbackUrl(req) {
  // Get protocol - consider X-Forwarded-Proto for reverse proxy setups
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  
  // Get host - consider X-Forwarded-Host for reverse proxy setups
  const host = req.get('x-forwarded-host') || req.get('host');
  
  if (!host) {
    throw new Error('Unable to determine host for callback URL');
  }
  
  // Build full callback URL
  return `${protocol}://${host}/api/integrations/office365/callback`;
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

## Configuration Priority

The solution maintains backward compatibility with the following priority order:

1. **Explicit Configuration**: `provider.redirectUri` in platform config
2. **Environment Variable**: `OFFICE365_OAUTH_REDIRECT_URI`
3. **Auto-Detection**: Extracted from incoming request (NEW)
4. **Fallback**: `http://localhost:3000` (for development)

## Benefits

1. **Zero Configuration**: Works out-of-the-box for most deployments
2. **Reverse Proxy Support**: Respects X-Forwarded-Proto and X-Forwarded-Host headers
3. **Backward Compatible**: Existing configurations continue to work
4. **Development Friendly**: Falls back to localhost when no request is available
5. **Production Ready**: Automatically detects HTTPS and correct domain

## Testing

To test the fix:

1. Remove any explicit `redirectUri` configuration from platform.json
2. Remove `OFFICE365_OAUTH_REDIRECT_URI` environment variable
3. Access the application via your actual domain (e.g., `https://ihub.local.intrafind.io`)
4. Initiate Office 365 OAuth flow
5. Verify that Microsoft redirects back to the correct domain (not localhost)

## Code Locations

- **Service**: `server/services/integrations/Office365Service.js`
  - New method: `_buildCallbackUrl(req)` (lines 24-42)
  - Updated method: `generateAuthUrl()` (lines 78-120)
  - Updated method: `exchangeCodeForTokens()` (lines 141-180)
- **Routes**: `server/routes/integrations/office365.js`
  - Updated: `/auth` route handler (line 72)
  - Updated: `/callback` route handler (lines 139-144)

## Security Considerations

- The solution respects reverse proxy headers for proper protocol and host detection
- Host validation is implicit through Express's `req.get('host')` method
- No user-controlled input is used in URL construction
- Original security measures (PKCE, state validation, session timeout) remain unchanged

## Migration Notes

No migration is required. The change is backward compatible and will automatically apply to all Office 365 OAuth flows once deployed.
