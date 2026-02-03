# JWT User Validation Security Fix

**Date**: 2026-02-03  
**Issue**: Security: Users which have been deleted or disabled, can still work with a valid JWT  
**Status**: ✅ Implemented  

## Problem Statement

When a user logs in to the iHub Apps platform, they receive a JWT (JSON Web Token) that is used for subsequent authentication. However, this JWT remained valid even after:

1. The user account was disabled (`active: false`)
2. The user account was deleted from the database

This created a security vulnerability where:
- Administrators could not effectively disable user access
- Deleted users could continue using the system with old JWT tokens
- There was no way to immediately revoke access for compromised accounts

## Root Cause Analysis

The JWT authentication middleware (`server/middleware/jwtAuth.js`) was validating JWT tokens using only:
- JWT signature verification
- Expiration time check

For local authentication, the middleware did **not** validate:
- Whether the user still exists in the database
- Whether the user account is still active

This was different from OAuth client validation, which already included checks for client existence and active status.

## Solution

Added user validation to the JWT authentication middleware for local auth mode, following the same pattern as OAuth client validation.

### Implementation Details

**File Modified**: `server/middleware/jwtAuth.js`

1. **Imports Added**:
   ```javascript
   import { loadUsers, isUserActive } from '../utils/userManager.js';
   ```

2. **Validation Logic** (lines 173-221):
   ```javascript
   else if (decoded.authMode === 'local') {
     const localAuthConfig = platform.localAuth || {};
     if (localAuthConfig.enabled) {
       try {
         const usersFilePath = localAuthConfig.usersFile || 'contents/config/users.json';
         const usersConfig = loadUsers(usersFilePath);
         const userId = decoded.sub || decoded.username || decoded.id;

         // Check if user exists
         const userRecord = usersConfig.users?.[userId];
         if (!userRecord) {
           return res.status(401).json({
             error: 'invalid_token',
             error_description: 'User account no longer exists'
           });
         }

         // Check if user is active
         if (!isUserActive(userRecord)) {
           return res.status(403).json({
             error: 'access_denied',
             error_description: 'User account has been disabled'
           });
         }

         // User is valid, create user object
         user = { /* ... */ };
       } catch (loadError) {
         logger.error('[JWT Auth] Failed to validate user status:', loadError);
         // Return 503 to prevent authentication bypass
         return res.status(503).json({
           error: 'service_unavailable',
           error_description: 'Unable to validate user credentials. Please try again later.'
         });
       }
     }
   }
   ```

3. **Error Handling Strategy**:
   - **401 Unauthorized**: User account no longer exists (deleted)
   - **403 Forbidden**: User account has been disabled
   - **503 Service Unavailable**: Database cannot be loaded (prevents bypass)
   - **401 Unauthorized**: Local authentication is disabled

## Security Improvements

### Before
- ❌ Disabled users could still use valid JWT tokens
- ❌ Deleted users could access the system with old tokens
- ❌ No way to immediately revoke access
- ❌ Database errors allowed authentication to proceed (bypass vulnerability)

### After
- ✅ Disabled users receive 403 error
- ✅ Deleted users receive 401 error
- ✅ Access can be revoked by setting `active: false`
- ✅ Database errors reject authentication (503 error)

## Testing

### Test Files Created

1. **`server/tests/jwt-user-validation.test.js`**
   - Jest unit tests
   - Tests active, disabled, and deleted user scenarios
   - Tests cookie and header token validation

2. **`server/tests/manual-test-jwt-validation.js`**
   - Manual test script
   - Simulates JWT validation logic
   - Confirms behavior for all user states

3. **`server/tests/integration-test-jwt-validation.js`**
   - HTTP integration tests
   - Tests actual server endpoints
   - Creates test users for validation

### Test Results

```
✓ Active users can use their JWT tokens
✓ Deleted users receive 401 "User account no longer exists"
✓ Disabled users receive 403 "User account has been disabled"
✓ Database errors receive 503 "Service unavailable"
```

## Code Quality Checks

- ✅ ESLint passed
- ✅ Prettier formatting passed
- ✅ Server startup test passed
- ✅ Code review completed (no issues)
- ✅ CodeQL security scan passed (0 vulnerabilities)

## Code Review Feedback

**Initial Issue**: The catch block allowed authentication to proceed even when user validation failed due to database errors.

**Fix Applied**: Changed error handling to return 503 Service Unavailable instead of allowing authentication to proceed. This prevents authentication bypass when the database is unavailable.

## Related Code Locations

- **JWT Middleware**: `server/middleware/jwtAuth.js` (lines 1-241)
- **User Manager**: `server/utils/userManager.js`
  - `loadUsers()` function (lines 18-103)
  - `isUserActive()` function (lines 330-332)
- **Authentication Routes**: `server/routes/auth.js`
- **Local Auth Middleware**: `server/middleware/localAuth.js`

## Migration Notes

This change is **backward compatible**:
- Existing valid users continue to work normally
- No database schema changes required
- No configuration changes required
- Existing JWT tokens are still accepted (if user is active)

## Deployment Notes

1. No server restart required for most deployments
2. JWT tokens for disabled users will be rejected immediately after deployment
3. JWT tokens for deleted users will be rejected immediately after deployment
4. No impact on OIDC, LDAP, or proxy authentication modes
5. OAuth client validation already had this behavior

## Future Considerations

1. **Token Revocation List**: Consider implementing a JWT revocation list for immediate token invalidation
2. **Audit Logging**: Add audit logs when JWT validation fails for disabled/deleted users
3. **Rate Limiting**: Consider rate limiting failed JWT validation attempts
4. **User Activity Tracking**: Update last active timestamp on successful JWT validation

## References

- Original Issue: GitHub Issue #XXX
- Pull Request: #XXX
- Related OAuth Client Validation: `server/middleware/jwtAuth.js` lines 86-127
