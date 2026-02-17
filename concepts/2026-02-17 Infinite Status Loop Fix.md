# Infinite Status Loop Fix - Login Authentication DDoS Prevention

**Date:** 2026-02-17  
**Issue:** Automatic DDoS via status endpoint on failed login attempts  
**Status:** Fixed

## Problem Description

When LDAP authentication was enabled and local authentication was disabled, failed login attempts would trigger an infinite loop of status requests to `/api/auth/status`, causing an automatic DDoS condition that could overwhelm the server.

### User Report
> "I've enabled LDAP auth and disabled local auth. When I tried to login, I saw infinite / loop of status requests. I guess because the login failed which triggered a status call?"

## Root Cause Analysis

### The Flow
1. User attempts login with incorrect credentials
2. Server responds with HTTP 401 (Unauthorized)
3. Axios response interceptor in `client/src/api/client.js` catches the 401 error
4. Interceptor dispatches `authTokenExpired` event (intended for expired session tokens)
5. AuthContext's event handler catches the event and calls `/api/auth/status` to check auth configuration
6. If the status call also returns 401 (no valid session), the cycle repeats → **infinite loop**

### Code Location
**File:** `client/src/api/client.js` (lines 77-94 before fix)

```javascript
// BEFORE - Problem code
if (error.response?.status === 401) {
  const currentToken = localStorage.getItem('authToken');
  if (currentToken) {
    console.log('Authentication token expired or invalid, clearing localStorage token');
    localStorage.removeItem('authToken');
  }
  
  // This fires for ALL 401 errors, including failed login attempts
  window.dispatchEvent(new CustomEvent('authTokenExpired'));
  
  return Promise.reject(error);
}
```

### Why It Happened
The `authTokenExpired` event was designed to handle **expired session tokens** during authenticated API calls. However, it was being triggered for **ALL** 401 errors, including:
- Failed login attempts
- Invalid credentials
- Missing credentials

This was inappropriate because:
1. Login failures should not trigger session expiration logic
2. The `authTokenExpired` handler tries to refresh auth status by calling `/api/auth/status`
3. If no valid session exists, this call also returns 401
4. This creates an infinite loop

## Solution

### Implementation
Modified the axios response interceptor to differentiate between:
1. **Login requests** - Should NOT trigger authTokenExpired event
2. **Authenticated requests** - Should trigger authTokenExpired event when session expires

### Code Changes
**File:** `client/src/api/client.js`

```javascript
// AFTER - Fixed code
if (error.response?.status === 401) {
  // Check if this is a login request - don't trigger token expiration for failed login attempts
  const isLoginRequest =
    originalRequest.url?.includes('/auth/login') ||
    originalRequest.url?.includes('/auth/oidc/') ||
    originalRequest.url?.includes('/auth/ntlm/');

  // Only dispatch authTokenExpired event for authenticated requests, not login attempts
  // This prevents infinite loops when login fails with 401
  if (!isLoginRequest) {
    const currentToken = localStorage.getItem('authToken');
    if (currentToken) {
      console.log('Authentication token expired or invalid, clearing localStorage token');
      localStorage.removeItem('authToken');
    }
    
    // Dispatch custom event for auth context to handle
    window.dispatchEvent(new CustomEvent('authTokenExpired'));
  }
  
  return Promise.reject(error);
}
```

### Affected Endpoints
The fix specifically excludes these authentication endpoints from triggering `authTokenExpired`:
- `/auth/login` - Local and LDAP authentication
- `/auth/oidc/*` - OpenID Connect authentication flows
- `/auth/ntlm/*` - NTLM authentication flows

## Testing Scenarios

### Manual Testing Required
1. **Failed Login with LDAP**
   - Enable LDAP auth, disable local auth
   - Attempt login with incorrect credentials
   - Verify: No infinite loop of status requests
   - Expected: Single 401 error, error message displayed to user

2. **Successful Login**
   - Test with correct credentials
   - Verify: Login succeeds normally
   - Expected: User is authenticated, redirected to app

3. **Token Expiration During Session**
   - Login successfully
   - Wait for token expiration or manually invalidate token
   - Make an API call (e.g., fetch apps list)
   - Verify: authTokenExpired event fires correctly
   - Expected: User is logged out or redirected to login

4. **OIDC Authentication**
   - Test OIDC login flow
   - Verify: No impact to OIDC authentication
   - Expected: OIDC flow works as before

5. **NTLM Authentication**
   - Test NTLM login flow
   - Verify: No impact to NTLM authentication
   - Expected: NTLM flow works as before

## Security Considerations

### What This Fixes
- **DDoS Prevention**: Prevents accidental self-DDoS from infinite status requests
- **Server Stability**: Prevents server overload from rapid repeated requests
- **User Experience**: Stops browser from hanging or becoming unresponsive

### What This Preserves
- **Session Expiration Handling**: Still detects and handles expired tokens correctly
- **Security**: Does not weaken authentication or authorization
- **Logout Behavior**: User is still logged out when session expires

## Related Files

### Modified
- `client/src/api/client.js` - Axios response interceptor

### Related (Not Modified)
- `client/src/shared/contexts/AuthContext.jsx` - Handles authTokenExpired event
- `server/routes/auth.js` - Authentication endpoints
- `server/middleware/ldapAuth.js` - LDAP authentication logic

## Future Improvements

1. **Rate Limiting**: Consider adding client-side rate limiting for auth status checks
2. **Exponential Backoff**: If status checks do need to retry, use exponential backoff
3. **Error Tracking**: Add telemetry to detect and alert on repeated auth failures
4. **Circuit Breaker**: Implement circuit breaker pattern for auth status checks

## References

- Issue: "Automatic DDoS via status endpoint"
- PR: [Link to PR when merged]
- Related: Session timeout and auto-relogin functionality
