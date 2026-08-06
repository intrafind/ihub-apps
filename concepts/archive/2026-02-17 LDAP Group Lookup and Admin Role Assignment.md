# LDAP Group Lookup and Admin Role Assignment

**Date**: 2026-02-17  
**Version**: 5.0.0  
**Type**: Enhancement & Documentation  
**Author**: GitHub Copilot

## Overview

This document describes how LDAP group lookup and automatic role assignment works in iHub Apps, including how to configure LDAP groups to map to internal groups (including the admin role).

## Problem Statement

A customer using LDAP authentication asked if automatic group assignment would work. They tested LDAP group retrieval directly and could receive groups from their LDAP server. However, they needed clear guidance on:

1. How to configure LDAP group mapping to internal groups
2. How to assign the admin role via LDAP group membership
3. How to troubleshoot group mapping issues
4. What logging is available to verify group assignments

## How LDAP Group Mapping Works

### Architecture Overview

The LDAP group mapping system follows this flow:

```
1. User logs in with LDAP credentials
   ↓
2. LDAP server authenticates user
   ↓
3. System extracts LDAP groups from LDAP response
   ↓
4. External LDAP groups are mapped to internal groups
   ↓
5. Internal groups determine user permissions
   ↓
6. User is granted access based on their permissions
```

### Key Components

#### 1. LDAP Authentication (`server/middleware/ldapAuth.js`)

The `authenticateLdapUser()` function:
- Authenticates the user against the LDAP server
- Extracts groups from the LDAP response (lines 60-73)
- Calls `mapExternalGroups()` to map LDAP groups to internal groups
- Returns a normalized user object with mapped groups

**Group Extraction Logic** (lines 62-73):
```javascript
let groups = [];
if (user.groups && Array.isArray(user.groups)) {
  groups = user.groups.map(group => {
    if (typeof group === 'string') {
      return group;
    } else if (group.cn) {
      return group.cn;
    } else if (group.name) {
      return group.name;
    }
    return String(group);
  });
}
```

This handles different LDAP group formats:
- Simple strings: `"IT-Admin"`
- CN objects: `{ cn: "IT-Admin" }`
- Name objects: `{ name: "IT-Admin" }`

#### 2. Group Mapping (`server/utils/authorization.js`)

The `mapExternalGroups()` function (lines 226-260):
- Takes an array of external LDAP groups
- Looks up each group in the group mapping configuration
- Returns an array of internal group IDs
- Logs unmapped groups for troubleshooting

**Enhanced Logging** (new in v5.0.0):
- Logs each successful group mapping
- Warns about unmapped groups with helpful guidance
- Provides clear troubleshooting information

#### 3. Group Configuration (`contents/config/groups.json`)

The groups configuration file defines:
- Internal groups (admins, users, authenticated, anonymous)
- Permissions for each group
- External group mappings via the `mappings` field

## Configuration Guide

### Step 1: Enable LDAP Authentication

Add LDAP configuration to `contents/config/platform.json`:

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate LDAP",
        "url": "ldap://ldap.example.com:389",
        "adminDn": "cn=admin,dc=example,dc=org",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=people,dc=example,dc=org",
        "usernameAttribute": "uid",
        "userDn": "uid={{username}},ou=people,dc=example,dc=org",
        "groupSearchBase": "ou=groups,dc=example,dc=org",
        "groupClass": "groupOfNames",
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

**Important**: The `groupSearchBase` and `groupClass` fields must be configured for group retrieval to work.

### Step 2: Configure Group Mappings

Edit `contents/config/groups.json` to map LDAP groups to internal groups.

#### Example: Mapping LDAP Groups to Admin Role

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "name": "Admins",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["IT-Admin", "IT-Admins", "Platform-Admin", "Administrators"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user access",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": ["Domain Users", "Employees", "Staff"]
    }
  }
}
```

**How Mappings Work**:
- The `mappings` array lists LDAP group names (case-sensitive)
- When a user's LDAP groups include "IT-Admin", they are assigned to the "admins" internal group
- Multiple LDAP groups can map to the same internal group
- One LDAP group can map to multiple internal groups

#### Example: Active Directory Configuration

For Active Directory environments:

```json
{
  "groups": {
    "admins": {
      "mappings": [
        "Domain Admins",
        "Enterprise Admins",
        "IT-Admin",
        "App-Administrators"
      ]
    },
    "users": {
      "mappings": [
        "Domain Users",
        "All-Employees"
      ]
    },
    "power-users": {
      "id": "power-users",
      "name": "Power Users",
      "description": "Extended permissions for power users",
      "inherits": ["users"],
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": [
        "Power Users",
        "Advanced-Users"
      ]
    }
  }
}
```

### Step 3: Test LDAP Group Retrieval

1. **Check LDAP Server Configuration**:
   Use an LDAP client to verify groups are returned:
   ```bash
   ldapsearch -x -H ldap://ldap.example.com:389 \
     -D "cn=admin,dc=example,dc=org" \
     -w "password" \
     -b "ou=people,dc=example,dc=org" \
     "(uid=testuser)" memberOf
   ```

2. **Test Login and Check Logs**:
   - Log in with an LDAP user
   - Check server logs for group mapping information
   - Look for these log entries:
     - `[LDAP Auth] Extracted N LDAP groups for user X`
     - `[LDAP Auth] Mapped N LDAP groups to M internal groups`
     - `[Authorization] External group "X" mapped to internal groups: [...]`

3. **Verify Admin Access**:
   - Log in with a user who is in an LDAP group mapped to "admins"
   - Navigate to `/admin` route
   - Verify admin panel access is granted

## Logging and Troubleshooting

### Enhanced Logging (v5.0.0)

The system now provides detailed logging to help troubleshoot group mapping issues:

#### LDAP Authentication Logs

```
[LDAP Auth] Authentication successful for user: john.doe
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["IT-Admin", "Employees", "VPN-Users"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["admins", "users"]
```

#### Authorization Logs

```
[Authorization] Mapping external groups: ["IT-Admin", "Employees", "VPN-Users"]
[Authorization] External group "IT-Admin" mapped to internal groups: ["admins"]
[Authorization] External group "Employees" mapped to internal groups: ["users"]
[Authorization] External group "VPN-Users" has no mapping in groups configuration
[Authorization] 1 external groups have no mapping: ["VPN-Users"]
[Authorization] To map these groups, add them to the "mappings" field in contents/config/groups.json
[Authorization] Final mapped internal groups (2): ["admins", "users"]
```

### Common Issues and Solutions

#### Issue 1: No Groups Retrieved from LDAP

**Symptoms**:
```
[LDAP Auth] No groups found in LDAP response for user john.doe
```

**Solutions**:
1. Verify `groupSearchBase` is configured in `platform.json`
2. Check that `groupClass` matches your LDAP schema (e.g., `groupOfNames`, `group`, `groupOfUniqueNames`)
3. Ensure the user is a member of at least one group in LDAP
4. Test group retrieval with `ldapsearch`

#### Issue 2: Groups Not Mapped

**Symptoms**:
```
[Authorization] External group "IT-Admin" has no mapping in groups configuration
[Authorization] 1 external groups have no mapping: ["IT-Admin"]
```

**Solutions**:
1. Add the LDAP group name to the `mappings` field in `groups.json`
2. Ensure group names match exactly (case-sensitive)
3. Check for typos or extra whitespace
4. Restart the server after modifying `groups.json` (some changes require restart)

#### Issue 3: Admin Access Not Working

**Symptoms**:
- User can log in but cannot access `/admin` route
- User doesn't have `adminAccess: true` in their permissions

**Solutions**:
1. Verify the user's LDAP group is listed in the `mappings` for the "admins" group
2. Check that the "admins" group has `"adminAccess": true` in its permissions
3. Review the logs to see which internal groups the user was assigned
4. Ensure the LDAP group name exactly matches what's in LDAP (case-sensitive)

#### Issue 4: User Only Gets Anonymous Access

**Symptoms**:
```
[Authorization] No groups mapped, assigning anonymous group
```

**Solutions**:
1. Check that LDAP groups are being retrieved (see Issue 1)
2. Verify group mappings exist (see Issue 2)
3. Ensure at least one LDAP group maps to a non-anonymous internal group
4. Review `defaultGroups` configuration in `ldapAuth.providers[].defaultGroups`

### Debugging Steps

1. **Enable Debug Logging**:
   Set log level to `debug` in `platform.json`:
   ```json
   {
     "logging": {
       "level": "debug"
     }
   }
   ```

2. **Check LDAP Response**:
   Review the raw LDAP response in logs (when debug is enabled):
   ```
   [LDAP Auth] Authentication successful for user: john.doe
   // Raw LDAP user object includes groups
   ```

3. **Verify Group Mapping Configuration**:
   ```bash
   # Check groups.json exists and is valid JSON
   cat contents/config/groups.json | jq .
   ```

4. **Test with Known LDAP Groups**:
   - Use a test user with known LDAP groups
   - Verify those exact group names are in `groups.json` mappings
   - Test login and check logs

## Implementation Details

### Modified Files

1. **`server/middleware/ldapAuth.js`** (lines 58-79):
   - Added logging for extracted LDAP groups
   - Added logging for mapped internal groups
   - Logs count of groups for easy verification

2. **`server/utils/authorization.js`** (lines 226-260):
   - Enhanced `mapExternalGroups()` with detailed logging
   - Added warnings for unmapped groups
   - Added helpful troubleshooting messages in logs
   - Logs each successful group mapping

### Key Functions

- `authenticateLdapUser()` - LDAP authentication and group extraction
- `mapExternalGroups()` - Maps LDAP groups to internal groups
- `loadGroupMapping()` - Loads group mapping configuration
- `enhanceUserWithPermissions()` - Applies permissions based on groups

## Configuration Examples

### Example 1: Single Admin Group

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "company-ldap",
        "url": "ldap://ldap.company.com:389",
        "groupSearchBase": "ou=groups,dc=company,dc=com"
      }
    ]
  }
}
```

```json
{
  "groups": {
    "admins": {
      "mappings": ["IT-Admins"]
    }
  }
}
```

### Example 2: Multiple Admin Groups

```json
{
  "groups": {
    "admins": {
      "mappings": [
        "Domain Admins",
        "Platform Administrators",
        "IT-Management",
        "Super-Users"
      ]
    }
  }
}
```

### Example 3: Hierarchical Groups with Different Permissions

```json
{
  "groups": {
    "admins": {
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Administrators", "IT-Admin"]
    },
    "developers": {
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-3-opus", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Developers", "Dev-Team"]
    },
    "users": {
      "permissions": {
        "apps": ["chat", "translator"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["All Users", "Employees"]
    }
  }
}
```

### Example 4: Default Groups for Fallback

```json
{
  "ldapAuth": {
    "providers": [
      {
        "name": "company-ldap",
        "defaultGroups": ["users"]
      }
    ]
  }
}
```

This ensures all LDAP users get at least the "users" group if no LDAP groups map to internal groups.

## Security Considerations

1. **Group Name Matching is Case-Sensitive**:
   - "IT-Admin" ≠ "it-admin" ≠ "It-Admin"
   - Ensure exact case match between LDAP and configuration

2. **Admin Role Security**:
   - Only map trusted LDAP groups to the admins internal group
   - Regularly audit who is in admin LDAP groups
   - Use specific group names (not broad groups like "Domain Users")

3. **Principle of Least Privilege**:
   - Don't give all LDAP users admin access
   - Create specific LDAP groups for different permission levels
   - Map only necessary LDAP groups

4. **Logging Considerations**:
   - Group membership is logged for troubleshooting
   - Logs include usernames during authentication
   - Consider log retention and access policies

## Testing Checklist

- [ ] LDAP authentication works for standard users
- [ ] LDAP groups are extracted from LDAP response
- [ ] LDAP groups are mapped to correct internal groups
- [ ] Admin users (via LDAP groups) can access `/admin` route
- [ ] Non-admin users cannot access `/admin` route
- [ ] Logs show group extraction and mapping clearly
- [ ] Unmapped groups generate helpful warning messages
- [ ] Users with no mapped groups get appropriate fallback permissions

## Migration Notes

### For Existing Deployments

1. **No Configuration Changes Required** - Existing LDAP configurations continue to work
2. **Enhanced Logging** - More detailed logs help with troubleshooting
3. **Backwards Compatible** - All existing functionality preserved

### For New Deployments

1. Configure `groupSearchBase` and `groupClass` in LDAP provider
2. Add group mappings to `groups.json`
3. Test with known LDAP users
4. Review logs to verify correct group assignment

## Related Documentation

- `docs/ldap-ntlm-authentication.md` - Complete LDAP authentication guide
- `docs/authentication-architecture.md` - Overall authentication system
- `server/defaults/config/groups.json` - Example groups configuration
- `concepts/2025-01-18-LDAP-Authentication-Fix.md` - Previous LDAP improvements

## Future Enhancements

Potential improvements for future versions:

1. **Group Sync Caching** - Cache LDAP group lookups to reduce LDAP server load
2. **Dynamic Group Refresh** - Refresh groups periodically without re-login
3. **Group Name Normalization** - Auto-convert case for more flexible mapping
4. **UI for Group Management** - Admin UI to manage group mappings
5. **Group Sync Reports** - Dashboard showing group mapping statistics
6. **Wildcard Group Mappings** - Support pattern matching for group names

## Conclusion

LDAP group lookup and automatic role assignment fully works in iHub Apps. The system:

1. ✅ Retrieves groups from LDAP during authentication
2. ✅ Maps external LDAP groups to internal groups
3. ✅ Assigns admin role based on LDAP group membership
4. ✅ Provides detailed logging for troubleshooting
5. ✅ Supports flexible configuration for different LDAP environments

Customers need to:
1. Configure `groupSearchBase` in their LDAP provider
2. Add their LDAP group names to the `mappings` field in `groups.json`
3. Review server logs to verify group mapping works correctly

The enhanced logging introduced in v5.0.0 makes it much easier to identify and fix group mapping issues.
