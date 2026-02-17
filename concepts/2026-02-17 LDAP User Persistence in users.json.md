# LDAP User Persistence in users.json

**Date**: 2026-02-17  
**Type**: Enhancement  
**Author**: GitHub Copilot

## Overview

LDAP users are now persisted in `users.json` just like users from other authentication methods (OIDC, Proxy, Teams, NTLM). This ensures consistent user management across all authentication methods.

## Problem

Previously, LDAP-authenticated users were not stored in the `users.json` file. This meant:
- LDAP users couldn't be managed through the admin interface
- No activity tracking for LDAP users
- Inconsistent behavior compared to other authentication methods
- Couldn't manually assign internal groups to LDAP users

## Solution

### Changes Made

**1. Updated `server/middleware/ldapAuth.js`**:
- Added import for `validateAndPersistExternalUser` from `userManager.js`
- Modified `loginLdapUser()` function to persist users using the same pattern as OIDC/Proxy/NTLM
- Users are stored with `ldapData` containing:
  - `subject`: User ID from LDAP
  - `provider`: LDAP provider name
  - `lastProvider`: Last LDAP provider used
  - `username`: LDAP username

**2. Updated `server/utils/userManager.js`**:
- Added LDAP support to `createOrUpdateExternalUser()` function
- Added LDAP support to `findUserByIdentifier()` function
- Added LDAP support to `validateAndPersistExternalUser()` function
- Added LDAP to self-signup logic (defaults to `true` like NTLM)
- LDAP users are created/updated with `ldapData` section

**3. Updated `server/validators/platformConfigSchema.js`**:
- Added `allowSelfSignup` option to `ldapAuth` configuration (defaults to `true`)

## How It Works

### First Login (New User)

1. User authenticates with LDAP
2. Groups are retrieved from LDAP and mapped to internal groups
3. User object is created with:
   ```javascript
   {
     id: "user_abc123",
     username: "john.doe",
     email: "john.doe@example.com",
     name: "John Doe",
     active: true,
     authMethods: ["ldap"],
     internalGroups: [],  // Manual groups from admin
     ldapData: {
       subject: "john.doe",
       provider: "corporate-ldap",
       lastProvider: "corporate-ldap",
       username: "john.doe"
     },
     lastActiveDate: "2026-02-17",
     createdAt: "2026-02-17T20:00:00.000Z",
     updatedAt: "2026-02-17T20:00:00.000Z"
   }
   ```
4. User is saved to `contents/config/users.json`

### Subsequent Logins (Existing User)

1. User authenticates with LDAP
2. User is found in `users.json` by email or LDAP subject
3. User data is updated:
   - `lastActiveDate` updated if it's a new day
   - `updatedAt` timestamp refreshed
   - `ldapData` updated with latest provider info
4. Groups are merged:
   - LDAP groups (from current auth session) are mapped
   - Internal groups (manually assigned in admin) are added
   - Final groups = mapped LDAP groups + internal groups + auto groups (authenticated, defaults)

### Group Merging

The system merges three types of groups for LDAP users:

1. **External LDAP groups**: Retrieved from LDAP and mapped to internal groups via `groups.json` mappings
2. **Automatic internal groups**: Like "authenticated" and provider default groups
3. **Manual internal groups**: Assigned by administrators via the admin interface

## Configuration

### LDAP Configuration

No changes required to existing LDAP configuration. Users are persisted automatically.

Optional: Control self-signup for new LDAP users:

```json
{
  "ldapAuth": {
    "enabled": true,
    "allowSelfSignup": true,  // Default: true (allow new LDAP users to be created)
    "providers": [...]
  }
}
```

### Disabling Self-Signup

To prevent new LDAP users from being created automatically:

```json
{
  "ldapAuth": {
    "enabled": true,
    "allowSelfSignup": false,  // Only allow existing users in users.json
    "providers": [...]
  }
}
```

With `allowSelfSignup: false`:
- Existing users in `users.json` can log in with LDAP
- New users will get an error: "New user registration is not allowed"
- Administrators must pre-create users in the admin interface

## Benefits

### 1. Consistent User Management

All authentication methods (Local, OIDC, Proxy, Teams, NTLM, LDAP) now store users the same way.

### 2. Activity Tracking

LDAP users now have:
- `lastActiveDate`: Date of last login
- `createdAt`: When user first logged in
- `updatedAt`: When user data was last updated

### 3. Admin Interface Support

LDAP users can now be managed through the admin interface:
- View all LDAP users
- See which LDAP provider they use
- Manually assign internal groups
- Enable/disable user accounts
- See activity tracking

### 4. Mixed Authentication

Users can have multiple auth methods:
```json
{
  "authMethods": ["ldap", "oidc"],
  "ldapData": {...},
  "oidcData": {...}
}
```

### 5. Manual Group Assignment

Administrators can now assign internal groups to LDAP users that persist across logins:

```json
{
  "internalGroups": ["power-users", "beta-testers"]
}
```

These groups are merged with LDAP groups during each login.

## User Object Structure

### Complete LDAP User Example

```json
{
  "user_abc123": {
    "id": "user_abc123",
    "username": "john.doe@example.com",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "active": true,
    "authMethods": ["ldap"],
    "internalGroups": ["power-users"],
    "ldapData": {
      "subject": "john.doe",
      "provider": "corporate-ldap",
      "lastProvider": "corporate-ldap",
      "username": "john.doe"
    },
    "lastActiveDate": "2026-02-17",
    "createdAt": "2026-02-17T10:00:00.000Z",
    "updatedAt": "2026-02-17T20:00:00.000Z"
  }
}
```

## Logging

Enhanced logging shows when users are persisted:

```
[LDAP Auth] Authentication successful for user: john.doe
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["IT-Admin", "Employees", "VPN-Users"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["admins", "users"]
[LDAP Auth] User persisted in users.json: user_abc123
```

## Migration

### For Existing Deployments

**No action required**. The first time an LDAP user logs in after this update:
1. User is automatically created in `users.json`
2. All future logins will update the existing user record

### For New Deployments

Works automatically. No special configuration needed.

## Security Considerations

### Self-Signup Default

By default, `allowSelfSignup` is `true` for LDAP because:
- Users are already authenticated by the LDAP server
- LDAP servers are trusted authentication sources
- Similar to NTLM (domain controller authentication)

### Disabling Self-Signup

Organizations can set `allowSelfSignup: false` to:
- Require pre-approval of users by administrators
- Manually vet each user before granting access
- Control exactly who can access the system

### Active Status

Even with `allowSelfSignup: true`, administrators can:
- Disable user accounts by setting `active: false`
- Disabled users cannot log in even if LDAP authentication succeeds

## Compatibility

### Backwards Compatible

- ✅ Existing LDAP configurations work without changes
- ✅ No breaking changes to authentication flow
- ✅ Users are created automatically on first login

### Other Auth Methods

No impact on other authentication methods:
- Local authentication: No changes
- OIDC: No changes
- Proxy auth: No changes
- Teams: No changes
- NTLM: No changes

## Testing

To verify LDAP user persistence:

1. **Enable debug logging** (optional):
   ```json
   {
     "logging": { "level": "debug" }
   }
   ```

2. **Log in with LDAP user**

3. **Check `contents/config/users.json`**:
   ```bash
   cat contents/config/users.json | jq '.users'
   ```

4. **Verify user was created** with `ldapData` section

5. **Check logs** for persistence message:
   ```
   [LDAP Auth] User persisted in users.json: user_abc123
   ```

## Related Documentation

- Main LDAP documentation: `docs/ldap-ntlm-authentication.md`
- LDAP group mapping: `concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md`
- LDAP group fix: `concepts/2026-02-17 LDAP Group Retrieval Fix - Empty Groups.md`
- User manager implementation: `server/utils/userManager.js`
