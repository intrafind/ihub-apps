# OIDC Auto-Redirect Fix

**Date:** 2025-11-05  
**Status:** Implemented  
**Issue:** [AutoRedirect not working, if an session has existed before?]

## Problem Description

When using OIDC with Auto Redirect enabled, the following issue occurred:

1. **First visit** - User visits iHub for the first time → Auto-redirect works correctly → User is redirected to OIDC provider
2. **Subsequent visit after JWT expiration** - User returns to iHub after the JWT token has expired → Login dialog is shown → User must manually initiate login flow

The hypothesis was that the browser still had the old (expired) JWT token in localStorage and was using it when loading apps from the backend. The backend would return a 401 error with the expired token, causing the app to show the login dialog instead of auto-redirecting.

## Root Cause

The issue had two parts:

### Client-Side Issue

The `loadAuthStatus` function in `client/src/shared/contexts/AuthContext.jsx` (lines 139-143) had a problematic check:

```javascript
// OLD CODE - PROBLEMATIC
const hasValidToken = !!localStorage.getItem('authToken');
const urlParams = new URLSearchParams(window.location.search);
const isLogoutPage = urlParams.get('logout') === 'true';

if (data.autoRedirect && !data.authenticated && !hasValidToken && !isLogoutPage) {
  // Auto-redirect logic...
}
```

The `!hasValidToken` check only verified if a token **exists** in localStorage, not whether it's **valid**. When an expired token was present:

1. `hasValidToken` would be `true` (token exists)
2. `!hasValidToken` would be `false`
3. The auto-redirect condition would fail
4. User would see the login dialog instead of being auto-redirected

### Server-Side Issue

The JWT middleware in `server/middleware/jwtAuth.js` was returning a 401 error for expired tokens on ALL endpoints, including `/api/auth/status`. This prevented the status endpoint from responding with proper authentication status and auto-redirect information.

```javascript
// OLD CODE - PROBLEMATIC
if (decoded.exp && decoded.exp < now) {
  return res.status(401).json({
    error: 'Token expired',
    code: 'TOKEN_EXPIRED',
    message: 'Your session has expired. Please log in again.'
  });
}
```

When a user with an expired token called `/api/auth/status`, the middleware would return 401 before the endpoint could execute, preventing the frontend from receiving the `autoRedirect` information.

## Solution Implemented

The fix involves changes on both client and server:

### Client-Side Fixes

#### 1. Remove the `hasValidToken` check from auto-redirect condition

The server's `/api/auth/status` endpoint already tells us if the user is authenticated via the `data.authenticated` field. This is more reliable than checking localStorage because:
- The server validates the JWT token
- The server checks if the token is expired
- The server handles all authentication modes consistently

#### 2. Clear expired tokens immediately

Move the token cleanup logic **before** the auto-redirect check to ensure expired tokens don't interfere:

```javascript
// NEW CODE - FIXED
// If we had a token but auth status says not authenticated,
// it means the token was invalidated or expired - clear it immediately
const hadToken = !!localStorage.getItem('authToken');
if (hadToken) {
  console.log('🔐 Token invalidated by server (expired or auth mode change)');
  localStorage.removeItem('authToken');
}

// Check for auto-redirect scenario
// Only redirect if user is not authenticated AND not just logged out
const urlParams = new URLSearchParams(window.location.search);
const isLogoutPage = urlParams.get('logout') === 'true';

if (data.autoRedirect && !data.authenticated && !isLogoutPage) {
  // Auto-redirect logic...
}
```

### Server-Side Fixes

#### 3. Allow expired tokens to pass through to `/api/auth/status` endpoint

Modified the JWT middleware to allow expired tokens to continue to the `/api/auth/status` endpoint, so it can properly respond with authentication status and auto-redirect information:

```javascript
// NEW CODE - FIXED
const now = Math.floor(Date.now() / 1000);
if (decoded.exp && decoded.exp < now) {
  // For /api/auth/status endpoint, don't return 401 on expired token
  // Allow the endpoint to respond with proper auth status and auto-redirect info
  if (req.path === '/api/auth/status') {
    console.log('🔐 JWT Auth: Token expired, continuing to status endpoint');
    return next();
  }
  
  return res.status(401).json({
    error: 'Token expired',
    code: 'TOKEN_EXPIRED',
    message: 'Your session has expired. Please log in again.'
  });
}
```

Also handle the case where `jwt.verify()` throws a `TokenExpiredError`:

```javascript
catch (err) {
  // For /api/auth/status endpoint, allow expired/invalid tokens to pass through
  // so the endpoint can respond with proper auth status and auto-redirect info
  if (req.path === '/api/auth/status' && err.name === 'TokenExpiredError') {
    console.log('🔐 JWT Auth: Expired token on status endpoint, continuing');
    return next();
  }
  
  console.warn('🔐 jwtAuth: Token validation failed:', err.message);
  return next();
}
```

## Code Changes

**Files Modified:**

1. **`client/src/shared/contexts/AuthContext.jsx`**
   - Moved token cleanup before auto-redirect check (lines 137-143)
   - Removed the `!hasValidToken` condition from the auto-redirect check (line 150)
   - Updated the auto-redirect condition to rely solely on `!data.authenticated` and `!isLogoutPage`

2. **`server/middleware/jwtAuth.js`**
   - Added special handling for `/api/auth/status` endpoint when token is expired
   - Expired tokens on status endpoint now continue to next middleware instead of returning 401
   - Handles both manual expiration check and `TokenExpiredError` from jwt.verify()

## Testing

The fix ensures that:
1. Users are auto-redirected on first visit (no token in localStorage)
2. Users are auto-redirected when returning with an expired token
3. Users are NOT auto-redirected after manually logging out (logout page detection)
4. The 5-minute throttle on auto-redirect attempts still works to prevent infinite loops

## Related Files

- `client/src/shared/contexts/AuthContext.jsx` - Main authentication context with auto-redirect logic (CLIENT FIX)
- `server/middleware/jwtAuth.js` - JWT token validation middleware (SERVER FIX)
- `client/src/api/client.js` - API client with 401 error handling
- `server/routes/auth.js` - `/api/auth/status` endpoint that returns authentication status

## Security Considerations

This fix maintains security because:
1. The server still validates all tokens via JWT middleware
2. Expired tokens are cleared from localStorage immediately
3. The auto-redirect only triggers when the server confirms the user is not authenticated
4. The logout page detection prevents unwanted redirects after explicit logout

## Future Improvements

Potential enhancements for consideration:
1. Add client-side JWT expiration checking to detect expired tokens before calling the server
2. Implement automatic token refresh for near-expiry tokens
3. Add telemetry to track auto-redirect success rates
4. Consider adding a visual indicator during auto-redirect (loading spinner)
