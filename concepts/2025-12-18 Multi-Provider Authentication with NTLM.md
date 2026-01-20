# Multi-Provider Authentication with NTLM Support

**Date:** 2025-12-18  
**Status:** Implemented  
**Related Issue:** NTLM logout and local user login issue

## Overview

This document describes the implementation of multi-provider authentication support with explicit NTLM triggering. The feature allows users to choose between multiple authentication methods (NTLM, local, LDAP, OIDC) instead of being automatically signed in via NTLM SSO.

## Problem Statement

When NTLM authentication was configured alongside other authentication methods (e.g., local authentication), users were automatically authenticated via NTLM SSO on every request. This created the following issues:

1. **Cannot sign out and login as different user**: After logging out, users were immediately re-authenticated via NTLM
2. **Cannot access admin UI with local credentials**: Admin users could not sign in with local admin credentials to access the admin UI
3. **No provider selection**: Users had no way to choose which authentication method to use

### Example Scenario

A user is signed in via NTLM as a regular domain user. They want to sign out and log in as a local admin user to access the admin UI. However:

1. User clicks "Sign Out"
2. User is redirected to home page
3. NTLM middleware automatically re-authenticates the user via Windows credentials
4. User is logged back in as the domain user (not admin)
5. Admin UI is inaccessible unless domain users have admin permissions

## Solution

### Design Principle

**When multiple authentication providers are configured, show a login dialog with provider options instead of using SSO.**

This means:
- NTLM should only auto-authenticate when it's the ONLY enabled provider
- When multiple providers exist, present a login dialog with buttons for each provider
- NTLM authentication is triggered explicitly via a button click

### Implementation Details

#### 1. Multi-Provider Detection

Added helper function in `server/middleware/ntlmAuth.js`:

```javascript
function hasMultipleAuthProviders(platform) {
  const enabledProviders = [
    platform.localAuth?.enabled,
    platform.ldapAuth?.enabled,
    platform.oidcAuth?.enabled,
    platform.proxyAuth?.enabled
  ].filter(Boolean).length;
  
  return enabledProviders > 0; // NTLM + at least one other provider
}
```

#### 2. NTLM Middleware Modification

Modified `ntlmAuthMiddleware` in `server/middleware/ntlmAuth.js`:

```javascript
// When multiple auth providers are configured, NTLM should only activate when explicitly requested
const multipleProviders = hasMultipleAuthProviders(platform);
const ntlmRequested = req.query.ntlm === 'true' || req.session?.ntlmRequested === true;

// Check if this is the NTLM login endpoint
const isNtlmLoginEndpoint = req.url.includes('/api/auth/ntlm/login');

if (multipleProviders && !ntlmRequested && !isNtlmLoginEndpoint) {
  if (isDev) {
    console.log('[NTLM Debug] Multiple providers configured, skipping auto-NTLM (not explicitly requested)');
  }
  return next();
}
```

**Behavior:**
- If multiple providers are enabled AND NTLM is not explicitly requested → skip NTLM middleware
- If NTLM is the only provider → auto-authenticate (SSO behavior)
- If user clicks NTLM button → session flag is set, NTLM activates

#### 3. NTLM Login Endpoints

Added GET endpoint in `server/routes/auth.js`:

```javascript
app.get(buildServerPath('/api/auth/ntlm/login', basePath), async (req, res) => {
  // Mark session to indicate NTLM was explicitly requested
  if (req.session) {
    req.session.ntlmRequested = true;
  }

  // NTLM middleware will handle the challenge-response
  // After authentication, redirect to returnUrl
  const returnUrl = req.query.returnUrl || '/';
  res.redirect(returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'ntlm=success');
});
```

**Flow:**
1. User clicks "Windows Authentication" button in login dialog
2. Browser navigates to `/api/auth/ntlm/login?returnUrl=<current-url>`
3. Session flag `ntlmRequested` is set
4. NTLM middleware activates and performs challenge-response
5. User is authenticated and redirected back to `returnUrl`

#### 4. Logout Enhancement

Updated logout endpoint in `server/routes/auth.js`:

```javascript
app.post(buildServerPath('/api/auth/logout', basePath), (req, res) => {
  // Clear the authentication cookie
  res.clearCookie('authToken', { ... });

  // Clear NTLM session flag to prevent auto-relogin
  if (req.session) {
    req.session.ntlmRequested = false;
    // Regenerate session to ensure clean state
    req.session.regenerate(err => {
      if (err) {
        console.error('Session regeneration error:', err);
      }
    });
  }

  res.json({ success: true, message: 'Logged out successfully' });
});
```

**Behavior:**
- Clears auth token cookie
- Clears NTLM session flag
- Regenerates session to ensure clean state
- Prevents automatic re-authentication via NTLM

#### 5. Frontend Login Dialog

Updated `client/src/features/auth/components/LoginForm.jsx`:

Added NTLM provider detection:
```javascript
const hasNtlmAuth = authConfig?.authMethods?.ntlm?.enabled;
const ntlmDomain = authConfig?.authMethods?.ntlm?.domain;
```

Added NTLM button:
```jsx
{hasNtlmAuth && (
  <button
    type="button"
    onClick={handleNtlmLogin}
    className="..."
  >
    <span className="mr-2">🔐</span>
    {t('auth.login.windowsAuth', 'Windows Authentication')}
    {ntlmDomain && <span className="ml-1 text-xs text-gray-500">({ntlmDomain})</span>}
  </button>
)}
```

Added NTLM login handler:
```javascript
const handleNtlmLogin = () => {
  // Store current URL for return after NTLM authentication
  const returnUrl = window.location.href;
  
  // Redirect to NTLM login endpoint which will trigger NTLM authentication
  const ntlmLoginUrl = `/api/auth/ntlm/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  window.location.href = ntlmLoginUrl;
};
```

#### 6. Internationalization

Added translations in `shared/i18n/en.json` and `shared/i18n/de.json`:

```json
"auth": {
  "login": {
    "windowsAuth": "Windows Authentication",
    "ldapProvider": "LDAP Provider",
    "selectProvider": "Auto-detect"
  }
}
```

## User Experience

### Single Provider (NTLM Only)

**Behavior:** SSO (Single Sign-On)
- User accesses the application
- NTLM middleware automatically authenticates using Windows credentials
- User is immediately signed in (no login dialog)

### Multiple Providers (NTLM + Local/LDAP/OIDC)

**Behavior:** Provider Selection
- User accesses the application
- Login dialog is displayed with buttons for each provider:
  - 🔐 Windows Authentication (CORPORATE)
  - 🔑 Username/Password
  - 🏢 Microsoft / Google (if OIDC configured)
- User clicks "Windows Authentication"
- Browser navigates to `/api/auth/ntlm/login`
- NTLM challenge-response handshake occurs
- User is authenticated and redirected back

### Logout Flow

**Before Fix:**
1. User clicks "Sign Out"
2. User is redirected to home page
3. NTLM middleware auto-authenticates
4. User is logged back in immediately

**After Fix:**
1. User clicks "Sign Out"
2. Session flag `ntlmRequested` is cleared
3. User is redirected to home page with `?logout=true` parameter
4. NTLM middleware skips auto-authentication (multiple providers + no session flag)
5. Login dialog is displayed
6. User can choose any authentication method

## Configuration Examples

### NTLM Only (SSO)

```json
{
  "auth": {
    "mode": "ntlm"
  },
  "ntlmAuth": {
    "enabled": true,
    "domain": "CORPORATE",
    "domainController": "ldap://dc.corporate.com"
  },
  "localAuth": {
    "enabled": false
  }
}
```

**Behavior:** Automatic NTLM authentication (SSO)

### NTLM + Local (Multi-Provider)

```json
{
  "auth": {
    "mode": "local"
  },
  "ntlmAuth": {
    "enabled": true,
    "domain": "CORPORATE",
    "domainController": "ldap://dc.corporate.com"
  },
  "localAuth": {
    "enabled": true,
    "usersFile": "contents/config/users.json"
  }
}
```

**Behavior:** Login dialog with provider selection

### NTLM + LDAP + OIDC (Multi-Provider)

```json
{
  "auth": {
    "mode": "oidc"
  },
  "ntlmAuth": {
    "enabled": true,
    "domain": "CORPORATE"
  },
  "ldapAuth": {
    "enabled": true,
    "providers": [...]
  },
  "oidcAuth": {
    "enabled": true,
    "providers": [...]
  }
}
```

**Behavior:** Login dialog with all providers listed

## Technical Details

### Session Management

NTLM requires session support to track explicit activation:

```javascript
// In server/middleware/setup.js
app.use(session({
  secret: config.JWT_SECRET || 'fallback-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.USE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));
```

### NTLM Challenge-Response Flow

When user clicks "Windows Authentication":

1. **Request 1:** Browser → `/api/auth/ntlm/login?returnUrl=...`
   - Server sets `req.session.ntlmRequested = true`
   - NTLM middleware intercepts

2. **Response 1:** Server → Browser (401 + WWW-Authenticate: NTLM)
   - Browser receives challenge

3. **Request 2:** Browser → Server (Authorization: NTLM <type1>)
   - Browser sends Type 1 message

4. **Response 2:** Server → Browser (401 + WWW-Authenticate: NTLM <type2>)
   - Server sends challenge

5. **Request 3:** Browser → Server (Authorization: NTLM <type3>)
   - Browser sends credentials (encrypted)

6. **Response 3:** Server → Browser (302 Redirect)
   - Server validates credentials
   - Sets auth token cookie
   - Redirects to `returnUrl`

### Security Considerations

1. **Session Security:**
   - Session cookies are `httpOnly` and `secure` in production
   - Session is regenerated on logout to prevent fixation attacks

2. **NTLM Security:**
   - NTLM credentials are never stored
   - JWT token is generated after successful NTLM authentication
   - Token has configurable expiration (default 8 hours)

3. **CSRF Protection:**
   - Session cookies use `sameSite: 'lax'`
   - NTLM endpoints are GET (safe methods) or require valid session

## Files Modified

### Backend
1. `/server/middleware/ntlmAuth.js`
   - Added `hasMultipleAuthProviders()` function
   - Modified `ntlmAuthMiddleware()` to check for multiple providers

2. `/server/routes/auth.js`
   - Added GET endpoint for `/api/auth/ntlm/login`
   - Updated logout to clear NTLM session flag

### Frontend
3. `/client/src/features/auth/components/LoginForm.jsx`
   - Added NTLM provider detection
   - Added NTLM login button
   - Added `handleNtlmLogin()` handler

### Internationalization
4. `/shared/i18n/en.json`
   - Added `auth.login.windowsAuth`
   - Added `auth.login.ldapProvider`
   - Added `auth.login.selectProvider`

5. `/shared/i18n/de.json`
   - Added German translations for NTLM UI

## Testing

### Test Scenarios

1. **NTLM Only (SSO)**
   - ✓ User is automatically authenticated on first visit
   - ✓ No login dialog is shown
   - ✓ User can access all permitted resources

2. **NTLM + Local (Multi-Provider)**
   - ✓ Login dialog is shown on first visit
   - ✓ NTLM button is visible
   - ✓ Username/password form is visible
   - ✓ User can sign in with NTLM
   - ✓ User can sign in with local credentials
   - ✓ User can sign out and login with different method

3. **Logout with Multiple Providers**
   - ✓ User signs out successfully
   - ✓ Session flag is cleared
   - ✓ NTLM does not auto-authenticate
   - ✓ Login dialog is shown
   - ✓ User can choose any authentication method

4. **NTLM Button Click**
   - ✓ Clicking NTLM button triggers authentication flow
   - ✓ NTLM challenge-response completes successfully
   - ✓ User is redirected back to original page
   - ✓ Auth token is set correctly

### Manual Testing Steps

1. Configure both NTLM and local authentication
2. Start the server
3. Access the application in a browser
4. Verify login dialog is shown with both options
5. Click "Windows Authentication"
6. Verify NTLM authentication completes
7. Click "Sign Out"
8. Verify login dialog is shown again (no auto-login)
9. Sign in with local credentials
10. Verify admin UI is accessible

## Future Enhancements

1. **Remember Provider Preference**
   - Store user's preferred provider in localStorage
   - Auto-select last used provider on login dialog

2. **Provider Priority**
   - Configure default provider in platform.json
   - Show default provider first in login dialog

3. **Provider-Specific Styling**
   - Custom icons for each provider
   - Themed buttons based on provider type

4. **Smart Provider Detection**
   - Detect if browser supports Windows Integrated Auth
   - Hide NTLM option if not supported

5. **Fallback Authentication**
   - Allow fallback to other providers if primary fails
   - Configurable provider chain

## Related Documentation

- [NTLM Technical Reference](/docs/ntlm-technical-reference.md)
- [Authentication Architecture](/docs/authentication-architecture.md)
- [LDAP/NTLM Authentication](/docs/ldap-ntlm-authentication.md)
- [External Authentication Integration](/concepts/2025-07-18 External Authentication Integration.md)
- [NTLM Primary Auth Mode](/concepts/2025-11-05-NTLM-Primary-Auth-Mode.md)

## References

- Issue: "When NTLM is configured it is not possible to sign out and login as a local user"
- Comment by @manzke: "When local and ntlm auth is enabled, the login dialog has to be shown. if more than 1 provider is available, we do not support sso. the user will see the login dialog with the providers. for ntlm we have be able to trigger it via a button."
