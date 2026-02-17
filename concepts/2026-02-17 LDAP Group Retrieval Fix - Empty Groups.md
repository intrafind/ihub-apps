# LDAP Group Retrieval Fix - Empty Groups Issue

**Date**: 2026-02-17  
**Issue**: LDAP groups were empty even though the customer could retrieve groups directly from LDAP  
**Root Cause**: Incorrect parameter name passed to ldap-authentication library

## Problem

The customer reported that LDAP authentication logging showed the feature was working, but the groups array was always empty:

```
[LDAP Auth] Extracted 0 LDAP groups for user john.doe: []
[LDAP Auth] No groups found in LDAP response for user john.doe
```

Even though the customer confirmed they could retrieve groups directly from their LDAP server using `ldapsearch`.

## Root Cause Analysis

The issue was in `server/middleware/ldapAuth.js` where we pass configuration to the `ldap-authentication` npm library.

**Incorrect code** (line 42-44):
```javascript
...(ldapConfig.groupSearchBase && {
  groupSearchBase: ldapConfig.groupSearchBase,  // ❌ WRONG - library doesn't recognize this
  groupClass: ldapConfig.groupClass || 'groupOfNames'
})
```

According to the [ldap-authentication library documentation](https://github.com/shaozi/ldap-authentication), the correct parameter name is **`groupsSearchBase`** (with an 's'), not `groupSearchBase`.

### Library Documentation

From the ldap-authentication README:

> **Parameters:**
> - `groupsSearchBase`: if specified with groupClass, will serve as search base for authenticated user groups
> - `groupClass`: if specified with groupsSearchBase, will be used as objectClass in search filter for authenticated user groups
> - `groupMemberAttribute`: if specified with groupClass and groupsSearchBase, will be used as member name (if not specified this defaults to `member`)
> - `groupMemberUserAttribute`: if specified with groupClass and groupsSearchBase, will be used as the attribute on the user object (if not specified this defaults to `dn`)

## Solution

### Code Changes

**File**: `server/middleware/ldapAuth.js` (lines 40-47)

```javascript
// Group search configuration (optional)
// Note: ldap-authentication library uses 'groupsSearchBase' (with 's')
...(ldapConfig.groupSearchBase && {
  groupsSearchBase: ldapConfig.groupSearchBase, // ✅ CORRECT - map to library's expected param
  groupClass: ldapConfig.groupClass || 'groupOfNames',
  groupMemberAttribute: ldapConfig.groupMemberAttribute || 'member',
  groupMemberUserAttribute: ldapConfig.groupMemberUserAttribute || 'dn'
})
```

**Key Changes**:
1. Changed parameter name from `groupSearchBase` to `groupsSearchBase` when passing to library
2. Added `groupMemberAttribute` parameter (defaults to 'member')
3. Added `groupMemberUserAttribute` parameter (defaults to 'dn')
4. Added comment explaining the parameter name mapping

### Enhanced Logging

Added additional logging to help diagnose group retrieval issues:

**Configuration Logging** (lines 52-58):
```javascript
if (ldapConfig.groupSearchBase) {
  logger.info(
    `[LDAP Auth] Group search enabled - groupSearchBase: ${ldapConfig.groupSearchBase}, groupClass: ${ldapConfig.groupClass || 'groupOfNames'}`
  );
} else {
  logger.warn(`[LDAP Auth] Group search not configured - groupSearchBase is missing`);
}
```

**Raw LDAP Response Logging** (lines 71-78):
```javascript
logger.debug(`[LDAP Auth] Raw LDAP user object:`, {
  hasGroups: !!user.groups,
  groupsType: user.groups ? typeof user.groups : 'undefined',
  groupsIsArray: Array.isArray(user.groups),
  groupsLength: user.groups ? user.groups.length : 0,
  userKeys: Object.keys(user),
  sampleGroup: user.groups && user.groups.length > 0 ? user.groups[0] : 'none'
});
```

This helps see exactly what the LDAP library returns.

### Schema Updates

**File**: `server/validators/platformConfigSchema.js` (lines 50-54)

Added the new optional parameters to the validation schema:
```javascript
groupSearchBase: z.string().optional(),
groupClass: z.string().optional(),
groupMemberAttribute: z.string().optional(),
groupMemberUserAttribute: z.string().optional(),
```

## Configuration Remains Unchanged

**Important**: The customer-facing configuration in `contents/config/platform.json` remains the same. Customers still use `groupSearchBase` (without 's'):

```json
{
  "ldapAuth": {
    "providers": [{
      "groupSearchBase": "ou=groups,dc=example,dc=org",
      "groupClass": "groupOfNames"
    }]
  }
}
```

The mapping from `groupSearchBase` to `groupsSearchBase` happens internally in the middleware.

## Expected Behavior After Fix

With this fix, the logging should now show:

```
[LDAP Auth] Attempting authentication for user: john.doe
[LDAP Auth] LDAP server: ldap://ldap.example.com:389
[LDAP Auth] Group search enabled - groupSearchBase: ou=groups,dc=example,dc=org, groupClass: groupOfNames
[LDAP Auth] Authentication successful for user: john.doe
[LDAP Auth] Raw LDAP user object: {
  hasGroups: true,
  groupsType: 'object',
  groupsIsArray: true,
  groupsLength: 3,
  userKeys: ['uid', 'cn', 'mail', 'groups'],
  sampleGroup: 'IT-Admin'
}
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["IT-Admin", "Employees", "VPN-Users"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["admins", "users"]
```

## Testing

To verify the fix works:

1. **Enable debug logging** in `platform.json`:
   ```json
   {
     "logging": {
       "level": "debug"
     }
   }
   ```

2. **Ensure group search is configured**:
   ```json
   {
     "ldapAuth": {
       "providers": [{
         "groupSearchBase": "ou=groups,dc=example,dc=org",
         "groupClass": "groupOfNames"
       }]
     }
   }
   ```

3. **Log in with an LDAP user** and check the logs for:
   - "Group search enabled" message
   - Raw LDAP user object showing `hasGroups: true`
   - Extracted groups with count > 0

4. **Verify group mapping** works:
   - Check that LDAP groups map to internal groups
   - Verify admin access if user is in an admin LDAP group

## Additional Notes

### Optional Parameters

The ldap-authentication library supports additional group-related parameters that can be configured:

- `groupMemberAttribute`: Attribute used to identify group members (default: 'member')
  - OpenLDAP: Usually 'member' or 'uniqueMember'
  - Active Directory: Usually 'member'

- `groupMemberUserAttribute`: User attribute used for group membership (default: 'dn')
  - OpenLDAP: Usually 'dn'
  - Active Directory: Can be 'dn' or 'distinguishedName'

These are now configurable in `platform.json` if needed:

```json
{
  "ldapAuth": {
    "providers": [{
      "groupSearchBase": "ou=groups,dc=example,dc=org",
      "groupClass": "groupOfNames",
      "groupMemberAttribute": "uniqueMember",
      "groupMemberUserAttribute": "dn"
    }]
  }
}
```

### Active Directory

For Active Directory, the typical configuration is:
```json
{
  "groupSearchBase": "dc=example,dc=com",
  "groupClass": "group",
  "groupMemberAttribute": "member",
  "groupMemberUserAttribute": "dn"
}
```

## Related Files

- `server/middleware/ldapAuth.js` - Fixed parameter name mapping
- `server/validators/platformConfigSchema.js` - Added new optional parameters
- All documentation remains accurate (uses `groupSearchBase` which is correct for config)

## References

- [ldap-authentication library documentation](https://github.com/shaozi/ldap-authentication)
- [ldap-authentication npm package](https://www.npmjs.com/package/ldap-authentication)
- Original implementation: `concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md`
