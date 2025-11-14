# Session Timeout Auto-Relogin

**Created:** 2025-11-14  
**Status:** Implemented

## Problem Statement

When a user has the web application open and their session times out (e.g., closing laptop overnight), attempting to continue using the application results in errors:

- "An error occurred during streaming"
- "Connection timeout. Please try again."

This happens because:
1. The backend API returns a 401 response with `AUTH_REQUIRED` error code
2. The frontend doesn't automatically restart the authentication flow
3. Users are left in a broken state with no clear path to recovery

## Solution

Implement automatic session timeout detection and intelligent re-authentication flow that:

1. **Detects session expiration** when 401 errors occur
2. **Checks for auto-redirect configuration** from the authentication provider
3. **Automatically redirects** to the authentication provider if configured
4. **Preserves user context** by storing the current URL for post-authentication redirect
5. **Provides clear feedback** to users about what's happening

## Implementation Details

### Key Files Modified

#### 1. `client/src/shared/contexts/AuthContext.jsx`

Enhanced the `authTokenExpired` event handler to:
- Clear expired tokens from localStorage
- Store the current URL for return after re-authentication
- Check `/auth/status` endpoint for auto-redirect configuration
- Automatically redirect to auth provider if configured
- Prevent redirect loops with 5-minute cooldown per provider
- Dispatch `sessionExpiredReconnecting` event for UI feedback
- Fall back to normal logout if no auto-redirect is configured

Key logic:
```javascript
const handleTokenExpired = async () => {
  // Clear expired token
  localStorage.removeItem('authToken');
  
  // Store return URL
  if (!isLogoutPage) {
    sessionStorage.setItem('authReturnUrl', currentUrl);
  }
  
  // Check for auto-redirect configuration
  const response = await apiClient.get('/auth/status');
  
  if (data.autoRedirect && !isLogoutPage) {
    // Check cooldown to prevent loops
    if (!recentlyAttempted) {
      // Redirect to auth provider with return URL
      window.location.href = redirectUrl;
      return;
    }
  }
  
  // No auto-redirect, logout normally
  dispatch({ type: AUTH_ACTIONS.LOGOUT });
};
```

#### 2. `client/src/features/chat/hooks/useAppChat.js`

Enhanced error handling in the `handleEvent` callback to:
- Detect 401/authentication errors specifically
- Show user-friendly session expiration message
- Log session expiration for debugging
- Let the auth flow triggered by API client handle the redirect

Key changes:
```javascript
if (error.isAuthRequired || error.status === 401) {
  errorMessage = t('error.sessionExpired', 
    'Your session has expired. Please log in again to continue.');
  console.log('🔐 Session expired during chat message send');
}
```

#### 3. `shared/i18n/en.json` and `shared/i18n/de.json`

Added new translation keys:
- `error.sessionExpired` - Shown when session has expired
- `error.sessionExpiredReconnecting` - Shown during auto-redirect

### Flow Diagram

```
User Action (send message)
    ↓
API returns 401
    ↓
API client dispatches 'authTokenExpired' event
    ↓
AuthContext receives event
    ↓
Store current URL
    ↓
Check /auth/status for auto-redirect
    ↓
    ├─ Auto-redirect enabled? ──YES→ Redirect to auth provider
    │                                    ↓
    │                                User authenticates
    │                                    ↓
    │                                Return to stored URL
    │
    └─ Auto-redirect disabled? ──NO──→ Logout user
                                        ↓
                                   Show login page
```

### Security Considerations

1. **Loop Prevention**: 5-minute cooldown prevents infinite redirect loops
2. **URL Validation**: Only stores non-logout URLs for return
3. **Token Cleanup**: Always clears expired tokens immediately
4. **Event Isolation**: Auth events don't expose sensitive information

### User Experience

**Before:**
- User sees cryptic streaming error
- No clear indication of what went wrong
- Must manually refresh and login
- Loses context of what they were doing

**After:**
- Clear message: "Your session has expired"
- Automatic redirect to login (if configured)
- Returns to exact page they were on
- Seamless re-authentication experience

## Testing

### Manual Testing Checklist

1. **Session Timeout Scenario**
   - [ ] Open app and authenticate
   - [ ] Wait for session timeout (or simulate by clearing session)
   - [ ] Try to send a message
   - [ ] Verify auto-redirect occurs
   - [ ] Verify return to original page after login

2. **No Auto-Redirect Scenario**
   - [ ] Configure system without auto-redirect
   - [ ] Trigger session timeout
   - [ ] Verify user is logged out gracefully
   - [ ] Verify clear error message is shown

3. **Loop Prevention**
   - [ ] Trigger multiple session timeouts rapidly
   - [ ] Verify redirect only happens once per cooldown period

### Automated Testing

Existing authentication tests in `server/tests/` should continue to pass:
- `authentication-security.test.js`
- `frontend-auth-flow.test.js`
- `authentication-integration.test.js`

## Configuration

No new configuration required. The feature works with existing authentication configuration:

- If `platform.json` has `autoRedirect` configured → auto-redirect happens
- If no `autoRedirect` → normal logout behavior

## Future Enhancements

1. **Proactive Session Refresh**: Detect approaching session expiry and refresh token before it expires
2. **User Warning**: Show a warning 5 minutes before session expires
3. **Activity Detection**: Keep session alive while user is actively using the app
4. **Custom Timeout Handlers**: Allow apps to define custom behavior on timeout

## Related Files

- `client/src/api/client.js` - API client with 401 interceptor
- `client/src/api/utils/requestHandler.js` - Error handling utilities
- `server/middleware/authRequired.js` - Server-side auth middleware
- `concepts/authentication-authorization-concept.md` - Overall auth architecture

## Conclusion

This implementation provides a seamless re-authentication experience when sessions timeout, improving user experience and reducing frustration. The solution is minimal, secure, and leverages existing authentication infrastructure.
