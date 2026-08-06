# Admin Rescue System

**Date**: 2026-02-05  
**Status**: Implemented  
**Related Issue**: System Rescue: First / Last User has to be admin

## Overview

The Admin Rescue System is a safety mechanism to prevent administrators from losing access to the iHub Apps platform. It addresses two critical scenarios:

1. **First User Admin Assignment**: Automatically assigns admin rights to the first user when no admin exists
2. **Last Admin Protection**: Prevents deletion of the last admin user in the system

## Problem Statement

### Scenario 1: Fresh Installation / Auth Method Switch

When configuring a new authentication method or doing a fresh install:

1. Admin logs in with default credentials (demo admin)
2. Admin configures a new authentication method (e.g., NTLM, OIDC)
3. Admin disables local authentication
4. Admin logs in again with new authentication method
5. **Problem**: New auth method has no admin users configured → Admin loses all admin rights

### Scenario 2: Last Admin Deletion

When managing users in a running system:

1. System has one or more admin users
2. Admin deletes the last remaining admin user
3. **Problem**: No way to get admin access back

## Solution

### First User Admin Assignment

When a user authenticates and there are NO admin users in the system:
- Automatically assign the admin group to the authenticating user
- This applies to all authentication methods (local, OIDC, proxy, LDAP, NTLM)

**Implementation Logic:**
1. Check if any admin exists across ALL enabled authentication methods
2. If no admin exists, assign admin group to the current user
3. This happens after successful authentication but before JWT token generation

### Last Admin Deletion Protection

When attempting to delete a user via admin interface:
- Check if the user is the last admin in the system
- If yes, prevent deletion with a clear error message
- Require admin rights to be transferred to another user first

## Implementation Details

### New Module: `server/utils/adminRescue.js`

Contains four main functions:

#### `hasAnyAdmin(usersFilePath)`
Checks if at least one admin exists across all enabled authentication methods.

**Checks:**
1. **Persisted Users** (local, OIDC, proxy): Scans `users.json` for active users with admin groups
2. **LDAP Providers**: Checks if LDAP default groups include admin, or if external groups map to admin
3. **NTLM**: Checks if NTLM default groups include admin, or if external groups map to admin

**Returns:** `true` if any admin exists, `false` otherwise

#### `assignAdminGroup(userId, usersFilePath)`
Assigns an admin group to a user.

**Process:**
1. Load user from `users.json`
2. Check if user already has an admin group
3. Find an admin group (prefers 'admins' or 'admin')
4. Add admin group to user's `internalGroups` array
5. Save updated user configuration

**Returns:** `true` if admin group was assigned, `false` if user already has admin or doesn't exist

#### `ensureFirstUserIsAdmin(user, authMode, usersFilePath)`
Called after user authentication to ensure first user gets admin rights.

**Process:**
1. Skip for anonymous users
2. Skip for LDAP/NTLM users (admin rights via group mapping)
3. Check if any admin exists in system using `hasAnyAdmin()`
4. If no admin exists, call `assignAdminGroup()` for the user
5. Update user object with new admin group

**Returns:** Updated user object (potentially with admin group added)

#### `isLastAdmin(userId, usersFilePath)`
Checks if a user is the last admin in the system.

**Process:**
1. Count active admin users in `users.json`
2. Check if target user is an admin
3. Return `true` only if user is admin AND is the only admin

**Returns:** `true` if user is the last admin, `false` otherwise

### Integration Points

#### Local Authentication (`server/middleware/localAuth.js`)
```javascript
// After successful login, before JWT generation
userResponse = await ensureFirstUserIsAdmin(userResponse, 'local', usersFilePath);
```

#### External Authentication (`server/utils/userManager.js`)
```javascript
// In validateAndPersistExternalUser(), after user creation/update
userWithAdminCheck = await ensureFirstUserIsAdmin(userWithAdminCheck, authMethod, usersFilePath);
```

#### User Deletion (`server/routes/admin/auth.js`)
```javascript
// Before deleting user
if (isLastAdmin(userId, usersFilePath)) {
  return res.status(403).json({
    error: 'Cannot delete the last admin user',
    message: 'At least one admin user must exist in the system...'
  });
}
```

## Authentication Method Considerations

### Persisted Users (Local, OIDC, Proxy)
- Users stored in `contents/config/users.json`
- Admin rights assigned via `internalGroups` field
- First user admin assignment works by modifying `users.json`

### Non-Persisted Users (LDAP, NTLM)
- Users NOT stored in `users.json`
- Admin rights come from external group mappings
- System checks if external groups map to admin groups in `groups.json`
- If admin group mappings exist, assumes LDAP/NTLM users can be admins

## Edge Cases Handled

1. **Multiple Auth Methods Enabled**: Checks across ALL enabled methods
2. **Inactive Admin Users**: Ignores inactive users when counting admins
3. **User Already Admin**: Skips admin assignment if user already has admin rights
4. **External Group Mappings**: Considers external group mappings for LDAP/NTLM
5. **Error Handling**: Returns safe defaults on errors (assumes admin exists to prevent unintended changes)

## Security Considerations

- **Privilege Escalation Prevention**: Only assigns admin when NO admin exists
- **Audit Trail**: All admin assignments logged to server logs
- **Deletion Protection**: Cannot bypass last admin protection
- **Error Handling**: Fails safely (assumes admin exists rather than risking auto-assignment)

## Testing

Unit tests in `server/tests/adminRescue.test.js` cover:

1. **hasAnyAdmin**: 4 test cases
   - Empty users
   - Users without admin
   - Users with admin
   - Inactive admins

2. **assignAdminGroup**: 3 test cases
   - Successful assignment
   - Already has admin
   - User doesn't exist

3. **isLastAdmin**: 4 test cases
   - Single admin
   - Non-admin user
   - Multiple admins
   - Inactive admins

## Logging

Admin rescue operations are logged with `[AdminRescue]` prefix:

```javascript
// Admin found
logger.debug('[AdminRescue] Found admin user in persisted users: admin (user_123)');

// Admin assigned
logger.warn('⚠️ [AdminRescue] No admin found in system. Assigning admin rights to first user: john');
logger.info('✅ [AdminRescue] Assigned admin group 'admins' to user john (user_456)');

// Last admin protection
logger.debug('[AdminRescue] User user_789 is the last admin (total admins: 1)');
```

## Configuration Requirements

### Groups Configuration
Admin groups must be defined in `contents/config/groups.json`:

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "name": "Admins",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["IT-Admin", "IT-Admins"]
    }
  }
}
```

**Required:**
- At least one group with `permissions.adminAccess: true`
- Group can have any ID, but prefers 'admins' or 'admin'

### Users Configuration
Users stored in `contents/config/users.json`:

```json
{
  "users": {
    "user_123": {
      "id": "user_123",
      "username": "john",
      "active": true,
      "internalGroups": ["admins"],
      "passwordHash": "..."
    }
  }
}
```

## Future Enhancements

1. **Admin Transfer Wizard**: GUI to transfer admin rights before deletion
2. **Multi-Admin Enforcement**: Require minimum 2 admins for production systems
3. **Admin Recovery Mode**: Emergency admin creation via CLI/config file
4. **Admin Assignment Notification**: Email/notification when admin rights assigned
5. **Admin Audit Log**: Separate log file for all admin-related operations

## Migration Notes

- **Backwards Compatible**: Existing systems continue to work unchanged
- **No Configuration Changes**: No changes needed to existing config files
- **Automatic Activation**: Feature activates automatically on first use
- **No Breaking Changes**: Does not affect existing authentication flows

## Related Files

### Core Implementation
- `server/utils/adminRescue.js` - Main admin rescue utilities
- `server/middleware/localAuth.js` - Local auth integration
- `server/utils/userManager.js` - External auth integration
- `server/routes/admin/auth.js` - User deletion protection

### Tests
- `server/tests/adminRescue.test.js` - Unit tests

### Configuration
- `contents/config/groups.json` - Group definitions with admin permissions
- `contents/config/users.json` - User storage with group assignments
- `contents/config/platform.json` - Authentication method configuration
