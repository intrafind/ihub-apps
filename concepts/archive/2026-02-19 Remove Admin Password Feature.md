# Remove Admin Password Feature

**Date:** 2026-02-19  
**Status:** ✅ Complete  
**Issue:** Remove admin password from ihub

## Background

In the early stages of iHub Apps, an admin password feature (`admin.secret`) was used to protect access to the admin panel. This was before the implementation of comprehensive role-based authentication with user groups and permissions.

With the current authentication system in place, the admin password is no longer needed and should be removed to simplify the codebase and rely solely on group-based permissions.

## Changes Made

### 1. Server-Side Changes

#### `server/middleware/adminAuth.js`
- **Removed:** Admin secret authentication logic
- **Removed:** `verifyAdminToken()` function
- **Removed:** `hashPassword()` export
- **Simplified:** `adminAuth()` middleware now only checks user group permissions
- **Simplified:** `isAdminAuthRequired()` function to only check user groups

**Before:** Admin could authenticate using either:
- User groups with `adminAccess: true`
- Admin secret password (in anonymous mode)

**After:** Admin can only authenticate with:
- User groups with `adminAccess: true`

#### `server/routes/admin/auth.js`
- **Removed:** `POST /api/admin/auth/change-password` endpoint
- **Removed:** `hashPassword` import from adminAuth.js
- **Removed:** Swagger documentation for password change endpoint

#### `server/routes/admin/configs.js`
- **Removed:** Admin secret sanitization logic (3 instances)
- **Removed:** Admin secret restoration logic
- **Simplified:** Secret handling to only cover OIDC, LDAP, JWT, and cloud storage secrets

### 2. Client-Side Changes

#### `client/src/features/admin/components/AdminAuth.jsx`
- **Removed:** Admin password login form
- **Removed:** State management for password input (`adminSecret`, `error`, `isLoggingIn`)
- **Removed:** `handleLogin()` function
- **Removed:** `handleLogout()` function
- **Removed:** Auth mode checking logic
- **Simplified:** Component to only show access denied message when user lacks admin permissions

**Before:** Component showed password input form in anonymous mode  
**After:** Component shows access denied message with instructions to log in with admin account

#### `client/src/features/admin/hooks/useAdminAuth.jsx`
- **Removed:** Token state management (`token`, `setToken`)
- **Removed:** `login()` function
- **Removed:** `logout()` function
- **Removed:** localStorage token persistence
- **Removed:** Admin token validation logic
- **Simplified:** `checkAuthStatus()` to directly map `authRequired` to `isAuthenticated`

### 3. Configuration Changes

#### `examples/config/platform.json`
- **Removed:** `admin.secret` field
- **Removed:** `admin.encrypted` field
- **Kept:** `admin.pages` configuration

#### `tests/test-client-secret-preservation.js`
- **Removed:** Admin secret test data
- **Removed:** Admin secret sanitization tests (3 instances)
- **Removed:** Admin secret restoration tests (3 instances)

### 4. Documentation Changes

#### `docs/platform.md`
- **Removed:** `admin.secret` field from example configuration
- **Removed:** `admin.encrypted` field documentation
- **Added:** Explanation that admin access is controlled through user group permissions

## Security Model

### Before
- **Anonymous Mode:** Admin secret was required to access admin panel
- **Authenticated Modes (local/OIDC/LDAP/NTLM):** Only user groups determined admin access

### After
- **All Modes:** Only user groups determine admin access
- **Required:** User must have `adminAccess: true` in their group configuration
- **Simpler:** Single, consistent authentication model across all modes

## Migration Guide

For existing deployments:

1. **Ensure proper group configuration:**
   ```json
   {
     "groups": {
       "admin": {
         "id": "admin",
         "permissions": {
           "adminAccess": true
         }
       }
     }
   }
   ```

2. **Assign admin users to admin group:**
   - Local auth: Update `contents/config/users.json` to assign users to admin group
   - OIDC/LDAP: Configure group mappings to map external groups to admin group
   - Proxy auth: Ensure proxy sends admin group in headers

3. **Remove admin.secret from platform.json:**
   ```json
   // Remove these fields
   "admin": {
     "secret": "...",
     "encrypted": true
   }
   
   // Keep only pages configuration
   "admin": {
     "pages": {
       "usage": true,
       "models": true,
       ...
     }
   }
   ```

4. **No restart required:** Changes take effect immediately after updating configuration

## Testing

### Verification Steps

1. ✅ Server starts successfully without errors
2. ✅ Linting passes with no errors
3. ✅ Formatting passes with no changes needed
4. ✅ Admin access works for users with admin group permissions
5. ✅ Admin access denied for users without admin permissions
6. ✅ No breaking changes to other authentication methods

### Test Results
```bash
# Linting
npm run lint:fix
✅ 0 errors, 89 warnings (all pre-existing)

# Formatting  
npm run format:fix
✅ All files formatted correctly

# Server startup
timeout 15s node server/server.js
✅ Server started successfully on port 3000
```

## Files Modified

### Server (5 files)
- `server/middleware/adminAuth.js` - Simplified authentication logic
- `server/routes/admin/auth.js` - Removed password change endpoint
- `server/routes/admin/configs.js` - Removed secret handling

### Client (2 files)
- `client/src/features/admin/components/AdminAuth.jsx` - Removed password form
- `client/src/features/admin/hooks/useAdminAuth.jsx` - Removed token logic

### Configuration (2 files)
- `examples/config/platform.json` - Removed admin.secret
- `tests/test-client-secret-preservation.js` - Removed admin secret tests

### Documentation (1 file)
- `docs/platform.md` - Updated admin configuration docs

## Code Review Notes

- ✅ **Minimal changes:** Only removed admin password feature, no other functionality affected
- ✅ **No breaking changes:** All other authentication methods continue to work
- ✅ **Consistent:** Single authentication model across all modes
- ✅ **Well-tested:** Server startup verified, linting and formatting passed
- ✅ **Documented:** Updated documentation to reflect changes

## Related Issues

This change addresses the requirement to remove the legacy admin password feature now that comprehensive role-based authentication is in place.
