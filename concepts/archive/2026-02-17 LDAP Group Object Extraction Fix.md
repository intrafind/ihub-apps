# LDAP Group Object Extraction Fix

**Date**: 2026-02-17  
**Type**: Bug Fix  
**Issue**: Groups returned as "[object Object]" in logs

## Problem

When logging in with LDAP, groups were showing as "[object Object]" in the logs:

```
[Authorization] External group "[object Object]" has no mapping in groups configuration
```

The raw group data showed complex LDAP group objects:
```json
{
  "dn": "CN=Developers,OU=global,OU=UserGroups,OU=Security,OU=LANDSBERGER,DC=muc,DC=intrafind,DC=de",
  "objectClass": ["top", "group"],
  "cn": "Developers",
  "member": ["CN=Andreas Stibi,...", "CN=Dylan Schwikkard,...", ...]
}
```

## Root Cause

The LDAP library returns groups in different formats depending on the LDAP server and configuration:

1. **Simple strings**: `["Developers", "Users"]`
2. **Array of objects**: `[{cn: "Developers", dn: "...", ...}, ...]`
3. **Object with numeric keys**: `{"0": {cn: "Developers", ...}, "1": {cn: "Users", ...}}`

The original code only handled:
- Arrays of strings
- Arrays of objects with simple `cn` or `name` properties

When `user.groups` was an object (not an array), or when `cn` was an array, or when falling through to `String(group)`, it would produce "[object Object]".

## Solution

Enhanced the group extraction logic in `server/middleware/ldapAuth.js` to:

1. **Handle both array and object formats** for `user.groups`
2. **Extract group names from multiple attributes** with array support:
   - `cn` (Common Name)
   - `name`
   - `displayName`
   - `dn` (Distinguished Name) - extracts CN portion
3. **Skip problematic entries** instead of converting to "[object Object]"
4. **Log warnings** for groups that can't be extracted

### Code Changes

**Before**:
```javascript
if (user.groups && Array.isArray(user.groups)) {
  groups = user.groups.map(group => {
    if (typeof group === 'string') {
      return group;
    } else if (group.cn) {
      return group.cn;
    } else if (group.name) {
      return group.name;
    }
    return String(group);  // ❌ Creates "[object Object]"
  });
}
```

**After**:
```javascript
if (user.groups) {
  // Handle both array and object formats
  const groupsArray = Array.isArray(user.groups)
    ? user.groups
    : Object.values(user.groups).filter(g => g && typeof g === 'object');

  groups = groupsArray
    .map(group => {
      if (typeof group === 'string') {
        return group;
      }

      if (typeof group === 'object' && group !== null) {
        // Try cn (handle arrays)
        if (group.cn) {
          return Array.isArray(group.cn) ? group.cn[0] : group.cn;
        }
        // Try name (handle arrays)
        if (group.name) {
          return Array.isArray(group.name) ? group.name[0] : group.name;
        }
        // Try displayName (handle arrays)
        if (group.displayName) {
          return Array.isArray(group.displayName) ? group.displayName[0] : group.displayName;
        }
        // Extract from DN (e.g., "CN=Developers,OU=..." -> "Developers")
        if (group.dn) {
          const dnString = Array.isArray(group.dn) ? group.dn[0] : group.dn;
          const cnMatch = dnString.match(/^CN=([^,]+)/i);
          if (cnMatch) {
            return cnMatch[1];
          }
        }
      }

      // Log warning and skip
      logger.warn('Could not extract group name from group object', group);
      return null;
    })
    .filter(g => g !== null);  // ✅ Remove null entries
}
```

## Expected Behavior After Fix

### Before Fix
```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["[object Object]", "[object Object]", "[object Object]"]
[Authorization] External group "[object Object]" has no mapping in groups configuration
```

### After Fix
```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["Developers", "Users", "IT-Admin"]
[Authorization] External group "Developers" mapped to internal groups: ["developers"]
[Authorization] External group "Users" mapped to internal groups: ["users"]
[Authorization] External group "IT-Admin" mapped to internal groups: ["admins"]
```

## Supported LDAP Group Formats

The fix now handles all common LDAP group response formats:

### 1. Simple Strings (OpenLDAP, simple queries)
```javascript
user.groups = ["Developers", "Users"]
```

### 2. Array of Objects (Active Directory, detailed queries)
```javascript
user.groups = [
  {
    dn: "CN=Developers,OU=UserGroups,DC=example,DC=com",
    cn: "Developers",
    objectClass: ["top", "group"],
    member: [...]
  }
]
```

### 3. Object with Numeric Keys
```javascript
user.groups = {
  "0": { dn: "CN=Developers,...", cn: "Developers" },
  "1": { dn: "CN=Users,...", cn: "Users" }
}
```

### 4. Arrays in Attributes (some LDAP servers)
```javascript
user.groups = [
  { cn: ["Developers"], dn: ["CN=Developers,..."] }
]
```

## Edge Cases Handled

1. **Missing cn**: Extracts from `name`, `displayName`, or `dn`
2. **Array attributes**: Takes first element
3. **Null/undefined groups**: Skipped with warning
4. **Non-object, non-string**: Skipped with warning
5. **Object format**: Converts to array using `Object.values()`

## Logging Improvements

### Success Case
```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["Developers", "Users", "IT-Admin"]
```

### Problematic Group Warning
```
[LDAP Auth] Could not extract group name from group object for user john.doe: {someField: "value"}
```

## Testing

To verify the fix:

1. **Log in with LDAP user** who has groups
2. **Check server logs** for extracted groups
3. **Verify** no "[object Object]" appears in logs
4. **Confirm** actual group names are shown

Example log output:
```
[LDAP Auth] Authentication successful for user: john.doe
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["Developers", "Users", "IT-Admin"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["developers", "admins"]
```

## Impact

✅ **Fixes**: "[object Object]" in logs  
✅ **Supports**: Multiple LDAP group response formats  
✅ **Backwards Compatible**: Works with existing simple string format  
✅ **Active Directory**: Full support for complex group objects  
✅ **OpenLDAP**: Works with both simple and detailed responses  

## Related Issues

- Original LDAP group retrieval fix: `concepts/2026-02-17 LDAP Group Retrieval Fix - Empty Groups.md`
- LDAP group mapping: `concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md`
