# NTLM Authentication Fix for Development Environment

**Date:** 2026-02-03  
**Status:** Fixed  
**Related Issue:** NTLM does not work when two auth methods are activated  
**Files Modified:**
- `server/middleware/ntlmAuth.js`
- `server/middleware/setup.js`

## Problem Statement

When NTLM authentication was configured alongside other authentication methods (e.g., local auth), clicking the NTLM button in the development environment resulted in an error:

```json
{
  "error": "NTLM authentication in progress. Please ensure Windows Integrated Authentication is enabled in your browser."
}
```

### Environment Details

- **Dev Environment**: User accessed `http://localhost:5173/` (Vite dev server)
- **Configuration**: Both NTLM and local auth enabled
- **User Action**: Clicked "Windows Authentication" button
- **Expected**: NTLM challenge-response authentication flow
- **Actual**: Error message indicating authentication not working

### Reproduction Steps

1. Configure both NTLM and local authentication in `platform.json`
2. Start development server (`npm run dev`)
3. Access application at `http://localhost:5173/`
4. Login dialog shows both authentication options
5. Click "Windows Authentication" button
6. Browser navigates to `http://localhost:5173/api/auth/ntlm/login?returnUrl=...`
7. **Error**: "NTLM authentication in progress..."

## Root Cause Analysis

The issue was caused by overly broad Vite proxy detection in the NTLM middleware. The middleware contained logic to skip NTLM authentication for requests coming through the Vite dev proxy to avoid authentication loops on regular API calls.

### The Problematic Code Flow

1. User clicks NTLM button → browser navigates to `/api/auth/ntlm/login?returnUrl=...`
2. In development, Vite proxies this to the backend server (port 3000)
3. NTLM middleware executes with these request properties:
   - `req.headers.referer`: `http://localhost:5173/...` (contains '5173')
   - `req.hostname`: `localhost`
   - `process.env.NODE_ENV`: `development`

4. **Vite proxy detection logic triggered** (lines 270-284):
   ```javascript
   const isViteProxy =
     skipNtlmForVite &&
     process.env.NODE_ENV === 'development' &&
     (req.hostname === 'localhost' || req.hostname === '127.0.0.1') &&
     (req.headers.origin?.includes('5173') || req.headers.referer?.includes('5173'));
   
   if (isViteProxy) {
     return next(); // SKIPS NTLM MIDDLEWARE!
   }
   ```

5. Middleware returns `next()` without setting up NTLM authentication
6. Request reaches the route handler at `/api/auth/ntlm/login`
7. Route handler checks `if (!req.ntlm || !req.ntlm.Authenticated)` → **true** (because middleware was skipped)
8. Returns error: "NTLM authentication in progress..."

### Additional Issues Found

1. **Incorrect path matching logic** (line 293):
   ```javascript
   const isNtlmLoginEndpoint =
     req.path === '/api/auth/ntlm/login' || req.path.startsWith('/api/auth/ntlm/login?');
   ```
   
   The second condition `req.path.startsWith('/api/auth/ntlm/login?')` would **never** match because:
   - `req.path` in Express contains the path **without** query string
   - Query string is only in `req.url` or `req.originalUrl`
   - Example: `req.path = '/api/auth/ntlm/login'`, `req.url = '/api/auth/ntlm/login?returnUrl=...'`

2. **Session middleware not configured for NTLM**: The session middleware setup only enabled sessions for:
   - OIDC authentication (path-specific: `/api/auth/oidc`)
   - Integration OAuth (path-specific: `/api/integrations`)
   - Local/LDAP auth modes (app-wide)
   
   But NTLM requires session support to track the `ntlmRequested` flag when multiple auth providers are enabled.

## Solution

### Fix 1: Vite Proxy Detection Exception

**File:** `server/middleware/ntlmAuth.js`

Added exception to the Vite proxy detection logic to **always allow** NTLM authentication on the explicit login endpoint:

```javascript
// Check if this is the NTLM login endpoint - use exact path matching for security
// Note: req.path does not include query string, so just check the path
const isNtlmLoginEndpoint = req.path === '/api/auth/ntlm/login';

// Skip NTLM for Vite proxy in development to avoid authentication loops
// EXCEPTION: Always allow NTLM on the explicit login endpoint, even through Vite proxy
const skipNtlmForVite = process.env.SKIP_NTLM_VITE_PROXY !== 'false';
const isViteProxy =
  !isNtlmLoginEndpoint && // Don't skip NTLM login endpoint
  skipNtlmForVite &&
  process.env.NODE_ENV === 'development' &&
  (req.hostname === 'localhost' || req.hostname === '127.0.0.1') &&
  (req.headers.origin?.includes('5173') || req.headers.referer?.includes('5173'));
```

**Key Change:** Added `!isNtlmLoginEndpoint` condition to the Vite proxy check, ensuring the login endpoint is never skipped.

**Logic Flow After Fix:**
1. Check if request is to `/api/auth/ntlm/login` endpoint → `isNtlmLoginEndpoint = true`
2. Check if request is from Vite proxy → `isViteProxy = false` (because of `!isNtlmLoginEndpoint`)
3. NTLM middleware executes normally
4. Authentication challenge-response completes
5. User is authenticated and redirected

### Fix 2: Path Matching Logic

**File:** `server/middleware/ntlmAuth.js`

Removed the incorrect second condition and simplified the endpoint detection:

```javascript
// Before (incorrect):
const isNtlmLoginEndpoint =
  req.path === '/api/auth/ntlm/login' || req.path.startsWith('/api/auth/ntlm/login?');

// After (correct):
const isNtlmLoginEndpoint = req.path === '/api/auth/ntlm/login';
```

Also moved this check to happen **before** the Vite proxy detection so it can be used in that logic.

### Fix 3: Session Middleware for NTLM

**File:** `server/middleware/setup.js`

Updated the session middleware setup to include NTLM authentication:

```javascript
// Before:
if (authConfig.mode === 'local' || authConfig.mode === 'ldap') {
  logger.info('🍪 Enabling minimal session middleware for local/LDAP authentication');
  // ... setup session
}

// After:
const ntlmConfig = platformConfig.ntlmAuth || {};

if (authConfig.mode === 'local' || authConfig.mode === 'ldap' || ntlmConfig.enabled) {
  const enabledMethods = [];
  if (authConfig.mode === 'local') enabledMethods.push('local');
  if (authConfig.mode === 'ldap') enabledMethods.push('LDAP');
  if (ntlmConfig.enabled) enabledMethods.push('NTLM');
  
  logger.info(`🍪 Enabling session middleware for: ${enabledMethods.join(', ')} authentication`);
  // ... setup session
}
```

This ensures that when NTLM is enabled, session middleware is available for tracking the `ntlmRequested` flag.

## Testing

### Manual Testing Steps

1. **Setup:**
   - Configure both NTLM and local auth in `platform.json`
   - Ensure `ntlmAuth.enabled: true` and `localAuth.enabled: true`
   - Start development server: `npm run dev`

2. **Test NTLM Login:**
   - Access `http://localhost:5173/`
   - Login dialog should show both options:
     - 🔐 Windows Authentication (DOMAIN)
     - Username/Password form
   - Click "Windows Authentication" button
   - Browser navigates to `http://localhost:5173/api/auth/ntlm/login?returnUrl=...`
   - **Expected:** NTLM challenge-response handshake occurs
   - **Expected:** User is authenticated and redirected back
   - **Result:** ✅ NTLM authentication works correctly

3. **Test Local Login:**
   - Access `http://localhost:5173/`
   - Enter username and password
   - Click "Sign In"
   - **Expected:** Local authentication succeeds
   - **Result:** ✅ Local auth still works

4. **Test Logout and Re-login:**
   - Sign out
   - Login dialog is shown (NTLM doesn't auto-login)
   - User can choose either authentication method
   - **Result:** ✅ Multi-provider selection works correctly

### Production Testing

The fix only affects the NTLM login endpoint behavior, which should work in production as well:

1. In production, requests go directly to the backend (no Vite proxy)
2. The `isViteProxy` check will be false anyway (not development)
3. NTLM authentication proceeds normally
4. No regression expected in production

## Technical Details

### Why Vite Proxy Detection Exists

The Vite proxy detection was added to prevent authentication loops in development. Here's why:

1. **NTLM is a challenge-response protocol** requiring multiple HTTP round trips
2. **Vite dev server (port 5173) proxies requests** to the backend (port 3000)
3. **NTLM challenges require specific headers** that Vite proxy doesn't handle well
4. **Without the check**, every API call would trigger NTLM challenge-response
5. **Result**: Infinite loop of 401 challenges on every request

### Why Exception is Safe

The exception for `/api/auth/ntlm/login` is safe because:

1. **Explicit user intent**: User clicked the NTLM button, explicitly requesting NTLM auth
2. **One-time flow**: Authentication happens once, then JWT token is used
3. **Session tracking**: `req.session.ntlmRequested` flag prevents auto-NTLM on subsequent requests
4. **Controlled endpoint**: Only this specific endpoint needs the exception

### Session Management

NTLM requires session support for multi-provider scenarios because:

1. **Session flag tracks explicit requests**: `req.session.ntlmRequested = true`
2. **Prevents auto-SSO when unwanted**: When multiple providers exist, don't auto-authenticate via NTLM
3. **Allows provider selection**: User sees login dialog and chooses their preferred method
4. **Logout cleanup**: Session flag is cleared on logout to prevent auto re-login

## Impact

### User Experience

**Before Fix:**
- ❌ NTLM button doesn't work in development
- ❌ Error message confuses users
- ❌ Can't test NTLM auth in dev environment

**After Fix:**
- ✅ NTLM button works in development
- ✅ Can test full NTLM flow locally
- ✅ Multi-provider authentication works as expected

### Developer Experience

**Before Fix:**
- ❌ Had to set `SKIP_NTLM_VITE_PROXY=false` to test NTLM
- ❌ Setting the flag caused issues with regular API calls
- ❌ Couldn't reliably test NTLM in development

**After Fix:**
- ✅ NTLM works out of the box in development
- ✅ No environment variable tweaking needed
- ✅ Explicit NTLM login endpoint always works
- ✅ Regular API calls still skip NTLM (no loops)

## Related Documentation

- [Multi-Provider Authentication with NTLM Support](./2025-12-18%20Multi-Provider%20Authentication%20with%20NTLM.md)
- [NTLM Technical Reference](/docs/ntlm-technical-reference.md)
- [LDAP/NTLM Authentication Guide](/docs/ldap-ntlm-authentication.md)
- [Authentication Architecture](/docs/authentication-architecture.md)

## Future Considerations

### Better Vite Proxy Handling

The current fix is a simple exception for the login endpoint. A more sophisticated approach could:

1. **Header-based detection**: Check for NTLM Authorization headers
2. **Path whitelist**: Maintain a list of NTLM-enabled endpoints
3. **Configuration flag**: Allow configuring which endpoints need NTLM

### Session Optimization

Currently, session is enabled app-wide when NTLM is enabled. Could optimize:

1. **Path-specific sessions**: Only enable for `/api/auth/ntlm/*` paths
2. **Lazy session creation**: Only create session when actually needed
3. **Memory-backed sessions**: Use in-memory store for development

### Development Experience

Could improve the development workflow:

1. **Auto-detect environment**: Automatically handle Vite proxy scenario
2. **Better error messages**: Explain why NTLM might fail in development
3. **Configuration validation**: Warn if NTLM is enabled but session is not configured

## Conclusion

The fix resolves the NTLM authentication issue in development by:

1. ✅ Adding an exception to Vite proxy detection for the explicit login endpoint
2. ✅ Fixing the incorrect path matching logic
3. ✅ Ensuring session middleware is available for NTLM

The changes are minimal, targeted, and maintain backward compatibility while enabling NTLM authentication to work correctly in multi-provider development environments.
