# Fix for Persistent "[object Object]" in Group Mapping

**Date**: 2026-02-17  
**Type**: Bug Fix  
**Commit**: This fix

## Problem

Even after the initial fix to extract group names from LDAP objects, the "[object Object]" warning was still appearing in logs during user persistence:

```
[Authorization] External group "[object Object]" has no mapping in groups configuration
```

## Root Cause

The issue was in the `loginLdapUser()` function. When persisting users to `users.json`, the code was passing `user.raw?.groups` (the original LDAP group objects) as `externalGroups` to the `validateAndPersistExternalUser()` function.

**Problem Flow**:
1. `authenticateLdapUser()` extracts group names from LDAP objects → produces string array `groups`
2. Groups are mapped using `mapExternalGroups(groups)` → works correctly, no "[object Object]"
3. User object created with `raw: user` (contains original LDAP response)
4. `loginLdapUser()` calls `validateAndPersistExternalUser()` with `externalGroups: user.raw?.groups`
5. `validateAndPersistExternalUser()` calls `mapExternalGroups()` again with the raw objects
6. Result: "[object Object]" appears in logs during user persistence

## Solution

Store the extracted group names (strings) in the user object and use them for persistence instead of the raw LDAP groups.

### Code Changes

**In `authenticateLdapUser()` (line ~165)**:

```javascript
const normalizedUser = {
  id: user.uid || user.sAMAccountName || user.cn || username,
  name: ...,
  email: ...,
  groups: mappedGroups,
  authenticated: true,
  authMethod: 'ldap',
  provider: ldapConfig.name || 'ldap',
  raw: user, // Keep raw LDAP data for debugging
  extractedGroups: groups // ✅ NEW: Store extracted LDAP group names (strings)
};
```

**In `loginLdapUser()` (line ~212)**:

**Before**:
```javascript
const externalUser = {
  ...
  externalGroups: user.raw?.groups || [], // ❌ Raw LDAP objects
  ...
};
```

**After**:
```javascript
const externalUser = {
  ...
  externalGroups: user.extractedGroups || [], // ✅ Extracted string array
  ...
};
```

## Impact

✅ **Eliminates "[object Object]" warnings** during user persistence  
✅ **Proper group mapping** in `validateAndPersistExternalUser()`  
✅ **Consistent behavior** between authentication and persistence  
✅ **No performance impact** - groups already extracted during authentication  

## Testing

After this fix, logs should show:

```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["Developers", "Users", "IT-Admin"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["developers", "admins"]
[LDAP Auth] User persisted in users.json: user_abc123
```

No "[object Object]" warnings should appear in the authorization logs.

## Related Files

- `server/middleware/ldapAuth.js` - Fixed in two places
- Previous fix: `concepts/2026-02-17 LDAP Group Object Extraction Fix.md` - Extraction logic
