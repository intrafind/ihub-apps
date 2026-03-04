# Fix: Automatic DDoS via Status Endpoint

**Date:** 2026-03-04  
**Issue:** Infinite loop of `/api/auth/status` requests when auth mode changes

## Problem Description

When an admin switches the authentication mode (e.g., from local auth to LDAP) and a user still has a valid token from the old auth mode in their browser (as an HTTP-only cookie and/or localStorage), the following infinite loop occurred:

1. User loads the app with an old `local` auth token stored in cookies/localStorage
2. `jwtAuth.js` middleware sees the token has `authMode: 'local'` but local auth is disabled → returns **HTTP 401**
3. The Axios response interceptor in `client.js` catches the 401 → clears localStorage token → dispatches `authTokenExpired` event
4. The `handleTokenExpired` listener in `AuthContext.jsx` fires → calls `apiClient.get('/auth/status')` again
5. The cookie (HTTP-only, cannot be cleared by JavaScript) is still sent with the new request → **HTTP 401 again**
6. → dispatch `authTokenExpired` → `handleTokenExpired` again → **infinite loop!**

This caused a self-inflicted DDoS on the server's `/api/auth/status` endpoint.

## Root Cause

The `jwtAuth.js` middleware rejected token requests with HTTP 401 for disabled auth modes even for the `/api/auth/status` endpoint. The status endpoint's purpose is to tell the client what auth methods are available — it should never return 401 regardless of token validity.

Additionally, the client's `handleTokenExpired` handler had no guard against concurrent/repeated execution, so multiple simultaneous 401 responses could each trigger it independently.

## Fix

### 1. Server: `server/middleware/jwtAuth.js`

Added a `rejectToken(statusCode, body)` helper that checks if the request is to `/api/auth/status`. For that endpoint, instead of returning a 4xx error, it calls `next()` to continue as anonymous. This covers all token rejection scenarios:

- Auth method disabled (local, OAuth, etc.)
- User account not found or disabled
- Service unavailable during user validation
- Token issued before secret rotation (OAuth)
- OAuth client not found or suspended

The `/api/auth/status` endpoint now always returns HTTP 200 with `authenticated: false` when a token is invalid, instead of HTTP 401.

### 2. Client: `client/src/shared/contexts/AuthContext.jsx`

Added an `isHandlingTokenExpired` ref to guard the `handleTokenExpired` event listener. When multiple simultaneous 401 responses fire the `authTokenExpired` event, only the first invocation proceeds. Subsequent calls are ignored until the guard is reset.

The guard is reset in `handleAuthGateSuccess` (when the user successfully re-authenticates), ensuring future session expiries are handled correctly.

### 3. Client: `client/src/auth-gate/auth-gate.js`

Added a fallback retry in `fetchAuthStatus()`: if the status endpoint returns HTTP 401 (which can happen for cookie-based tokens that can't be cleared by JavaScript), the function clears the stored token and retries the request without authentication credentials.

## Files Changed

- `server/middleware/jwtAuth.js` — Added `rejectToken` helper, replaced all `res.status(4xx)` calls with `rejectToken()` to bypass 4xx responses on the status endpoint
- `client/src/shared/contexts/AuthContext.jsx` — Added `isHandlingTokenExpired` ref guard to prevent concurrent `authTokenExpired` handling
- `client/src/auth-gate/auth-gate.js` — Added 401 retry logic in `fetchAuthStatus()` to clear stale tokens
