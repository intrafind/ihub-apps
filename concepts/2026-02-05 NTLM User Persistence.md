# NTLM User Persistence

**Date**: 2026-02-05  
**Status**: Implemented  
**Related Issue**: Users which login via NTLM are not visible in the users database

## Problem Statement

Users logging in via NTLM (Windows Integrated Authentication) were not being persisted to the users database, unlike users authenticating via OIDC or Proxy authentication. This prevented:

- Viewing NTLM users in the admin UI
- Managing NTLM user permissions and groups
- Tracking last usage and login activity
- Assigning internal groups to NTLM users

## Background

The application already had user persistence logic for OIDC and Proxy authentication methods via the `validateAndPersistExternalUser()` function in `server/utils/userManager.js`. This function:

1. Checks if a user exists in `contents/config/users.json`
2. Creates new users or updates existing ones
3. Tracks last active date
4. Merges external groups (from auth provider) with internal groups (manually assigned)
5. Validates user access based on `allowSelfSignup` configuration

However, NTLM authentication bypassed this persistence mechanism entirely, keeping user data only in memory during the session.

## Solution

### Implementation

Modified the NTLM authentication flow to use the same user persistence mechanism as OIDC and Proxy authentication.

#### Files Changed

1. **`server/middleware/ntlmAuth.js`**
   - Added import for `validateAndPersistExternalUser`
   - Made the middleware callback async
   - Added user persistence after authentication:
     ```javascript
     // Validate and persist NTLM user (similar to OIDC/Proxy)
     try {
       user = await validateAndPersistExternalUser(user, platform);
       logger.info(`[NTLM Auth] User persisted: ${user.id}`);
     } catch (userError) {
       logger.error('[NTLM Auth] User persistence error:', userError.message);
       // Continue with authentication even if persistence fails
     }
     ```
   - Made `processNtlmLogin()` function async
   - Added same persistence logic to the login function

2. **`server/utils/userManager.js`**
   - Updated `createOrUpdateExternalUser()` to recognize NTLM auth method
   - Added NTLM-specific data storage:
     ```javascript
     else if (authMethod === 'ntlm') {
       user.ntlmData = {
         subject: externalUser.id,
         provider: externalUser.provider,
         lastProvider: externalUser.provider,
         domain: externalUser.domain,
         workstation: externalUser.workstation
       };
     }
     ```
   - Updated `validateAndPersistExternalUser()` to handle NTLM auth config
   - Updated JSDoc to reflect NTLM support

3. **`server/routes/auth.js`**
   - Added `await` to both NTLM login routes (`GET` and `POST`)
   - Ensures async `processNtlmLogin()` completes before responding

### User Data Structure

NTLM users are now stored in `contents/config/users.json` with the following structure:

```json
{
  "user_abc123": {
    "id": "user_abc123",
    "username": "user@example.com",
    "email": "user@example.com",
    "name": "John Doe",
    "internalGroups": [],
    "active": true,
    "authMethods": ["ntlm"],
    "ntlmData": {
      "subject": "DOMAIN\\username",
      "provider": "ntlm",
      "lastProvider": "ntlm",
      "domain": "DOMAIN",
      "workstation": "WORKSTATION-01"
    },
    "lastActiveDate": "2026-02-05",
    "createdAt": "2026-02-05T12:30:00.000Z",
    "updatedAt": "2026-02-05T14:45:00.000Z"
  }
}
```

### Authentication Flow

1. User authenticates via NTLM (express-ntlm middleware)
2. NTLM data is processed by `processNtlmUser()`
3. User object is enhanced with groups via `enhanceUserGroups()`
4. **NEW**: User is persisted via `validateAndPersistExternalUser()`
5. User object is set on `req.user`
6. JWT token is generated (if configured)

### Error Handling

The implementation includes graceful error handling to prevent breaking existing authentication:

```javascript
try {
  user = await validateAndPersistExternalUser(user, platform);
  logger.info(`[NTLM Auth] User persisted: ${user.id}`);
} catch (userError) {
  logger.error('[NTLM Auth] User persistence error:', userError.message);
  // Continue with authentication even if persistence fails
}
```

This ensures that:
- Authentication continues even if database writes fail
- Existing NTLM authentication behavior is preserved
- Errors are logged for debugging

## Benefits

### For Administrators
- **Visibility**: NTLM users now appear in the admin UI at `/api/admin/auth/users`
- **Management**: Can assign internal groups to NTLM users
- **Tracking**: Can see when users last logged in
- **Consistency**: NTLM users are managed the same way as OIDC/Proxy users

### For Users
- **Persistent Permissions**: Internal group assignments persist across sessions
- **Better UX**: Group-based access controls work consistently
- **Activity Tracking**: Usage is tracked for analytics and compliance

## Configuration

### NTLM Authentication Settings

NTLM authentication is configured in `contents/config/platform.json`:

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "YOURDOMAIN",
    "domainController": "ldap://dc.yourdomain.com",
    "getGroups": true,
    "allowSelfSignup": true,
    "defaultGroups": ["authenticated"]
  }
}
```

### Self-Signup Control

The `allowSelfSignup` setting controls whether new NTLM users are automatically registered:

- **`true`**: New NTLM users are automatically added to the database
- **`false`**: Only pre-existing users can authenticate (new users are rejected)

This allows administrators to control user registration while still tracking existing users.

## Testing

### Manual Testing Steps

1. **Enable NTLM authentication** in `platform.json`
2. **Configure domain controller** (optional, for group retrieval)
3. **Authenticate** via NTLM from a Windows client
4. **Verify** user appears in admin UI:
   - Navigate to `/admin` (requires admin auth)
   - Check user list API: `GET /api/admin/auth/users`
   - Confirm user record exists with `authMethods: ["ntlm"]`
5. **Test activity tracking**:
   - Log in on different days
   - Verify `lastActiveDate` updates
6. **Test group assignment**:
   - Assign internal groups via admin UI
   - Log out and log back in
   - Verify groups are merged correctly

### Automated Testing

No automated tests added due to NTLM requiring Windows/AD infrastructure. Manual testing required in target environment.

## Compatibility

### Backward Compatibility
- ✅ Existing NTLM authentication continues to work
- ✅ Users created before this change are automatically persisted on next login
- ✅ Error handling prevents breaking changes

### Breaking Changes
- None - this is purely additive functionality

## Future Enhancements

Potential improvements for future consideration:

1. **Admin UI Enhancements**
   - Dedicated "NTLM Users" section in admin UI
   - Display NTLM-specific data (domain, workstation)
   - Bulk import of pre-approved NTLM users

2. **Group Synchronization**
   - Option to automatically sync external NTLM groups to internal groups
   - Group mapping configuration in admin UI

3. **Activity Reports**
   - Usage analytics for NTLM users
   - Login history and session tracking
   - Export user activity reports

4. **Multi-Domain Support**
   - Support for multiple NTLM domains
   - Domain-specific configuration
   - Cross-domain user matching

## References

### Related Code
- `server/middleware/ntlmAuth.js` - NTLM authentication middleware
- `server/middleware/oidcAuth.js` - OIDC authentication (reference implementation)
- `server/middleware/proxyAuth.js` - Proxy authentication (reference implementation)
- `server/utils/userManager.js` - User persistence logic
- `server/routes/admin/auth.js` - Admin user management API

### Related Configuration
- `contents/config/platform.json` - NTLM authentication settings
- `contents/config/users.json` - User database
- `contents/config/groups.json` - Group definitions and mappings

### Documentation
- `docs/authentication/ntlm.md` - NTLM authentication guide (if exists)
- Admin UI documentation for user management
