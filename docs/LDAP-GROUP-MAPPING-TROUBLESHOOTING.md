# LDAP Group Mapping Troubleshooting Guide

This guide helps you troubleshoot LDAP group mapping issues in iHub Apps.

## Quick Diagnostic Steps

### Step 1: Verify LDAP Groups Are Retrieved

Log in with an LDAP user and check the server logs for:

```
[LDAP Auth] Extracted N LDAP groups for user username: ["Group1", "Group2", ...]
```

**✅ If you see this**: LDAP group retrieval is working.  
**❌ If you don't**: See [No Groups Retrieved](#no-groups-retrieved-from-ldap).

### Step 2: Verify Groups Are Mapped

Check the server logs for:

```
[LDAP Auth] Mapped N LDAP groups to M internal groups for user username: ["admins", "users", ...]
```

**✅ If M > 0**: Some groups are mapped.  
**❌ If M = 0**: No groups are mapped, see [Groups Not Mapped](#groups-not-mapped-to-internal-groups).

### Step 3: Check for Unmapped Groups

Look for warnings in the logs:

```
[Authorization] External group "GroupName" has no mapping in groups configuration
[Authorization] N external groups have no mapping: ["Group1", "Group2", ...]
```

**ℹ️ This is normal** if some LDAP groups aren't needed in iHub Apps.  
**⚠️ Take action** if important groups (like admin groups) are unmapped.

## Common Issues

### No Groups Retrieved from LDAP

**Symptoms**:
```
[LDAP Auth] No groups found in LDAP response for user username
```

**Causes**:
1. `groupSearchBase` not configured
2. `groupClass` doesn't match LDAP schema
3. User is not a member of any groups
4. LDAP server doesn't return group information

**Solutions**:

#### 1. Configure Group Search Base

Edit `contents/config/platform.json`:

```json
{
  "ldapAuth": {
    "providers": [
      {
        "groupSearchBase": "ou=groups,dc=example,dc=org",
        "groupClass": "groupOfNames"
      }
    ]
  }
}
```

**Common `groupClass` values**:
- OpenLDAP: `groupOfNames` or `groupOfUniqueNames`
- Active Directory: `group`
- Other: Check your LDAP schema documentation

#### 2. Test with LDAP Search Tool

Verify groups are in LDAP:

```bash
# For generic LDAP
ldapsearch -x -H ldap://ldap.example.com:389 \
  -D "cn=admin,dc=example,dc=org" \
  -w "password" \
  -b "ou=people,dc=example,dc=org" \
  "(uid=testuser)" memberOf

# For Active Directory
ldapsearch -x -H ldap://ad.example.com:389 \
  -D "admin@example.com" \
  -w "password" \
  -b "dc=example,dc=com" \
  "(sAMAccountName=testuser)" memberOf
```

#### 3. Check LDAP Library Compatibility

The system uses `ldap-authentication` npm package. Ensure your LDAP server is compatible.

### Groups Not Mapped to Internal Groups

**Symptoms**:
```
[Authorization] External group "IT-Admin" has no mapping in groups configuration
[Authorization] No groups mapped, assigning anonymous group
```

**Causes**:
- LDAP group names don't match mappings in `groups.json`
- Case mismatch (group names are case-sensitive)
- Typos in configuration

**Solutions**:

#### 1. Add Group Mappings

Edit `contents/config/groups.json`:

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
      "mappings": ["IT-Admin", "Administrators", "Domain Admins"]
    }
  }
}
```

**Important**: Group names must match exactly (case-sensitive)!

#### 2. Find Your LDAP Group Names

Check the logs for the exact group names from LDAP:

```
[LDAP Auth] Extracted 3 LDAP groups: ["IT-Admin", "Employees", "VPN-Users"]
```

Copy these names exactly into your `mappings` field.

#### 3. Restart Server (If Needed)

Some configuration changes require server restart:

```bash
# Development
npm run dev

# Production
npm run start:prod
```

### Admin Access Not Working

**Symptoms**:
- User can log in successfully
- User cannot access `/admin` route
- Returns 403 Forbidden or redirects

**Diagnostic Steps**:

#### 1. Check User's Internal Groups

Look in the logs for:

```
[LDAP Auth] Mapped N LDAP groups to M internal groups for user: ["users"]
```

**✅ Should include**: `"admins"`  
**❌ Problem**: Only includes `"users"` or `"authenticated"`

#### 2. Verify Admin Group Mapping

Check `contents/config/groups.json`:

```json
{
  "admins": {
    "permissions": {
      "adminAccess": true  // Must be true
    },
    "mappings": ["IT-Admin"]  // Must include user's LDAP group
  }
}
```

#### 3. Test with Known Admin User

1. Create a test LDAP user in the "IT-Admin" group (or whatever group you mapped)
2. Log in with this user
3. Check logs:
   ```
   [LDAP Auth] Extracted 1 LDAP groups: ["IT-Admin"]
   [LDAP Auth] Mapped 1 LDAP groups to 1 internal groups: ["admins"]
   [Authorization] External group "IT-Admin" mapped to internal groups: ["admins"]
   ```
4. Navigate to `/admin` - should work

### User Gets Only Anonymous Access

**Symptoms**:
```
[Authorization] No groups mapped, assigning anonymous group
```

**Causes**:
- All LDAP groups are unmapped
- No default groups configured
- LDAP group retrieval failed

**Solutions**:

#### 1. Map at Least One LDAP Group

Ensure at least one of the user's LDAP groups is mapped:

```json
{
  "groups": {
    "users": {
      "mappings": ["Domain Users", "Employees", "All-Users"]
    }
  }
}
```

#### 2. Configure Default Groups

Add fallback groups in `platform.json`:

```json
{
  "ldapAuth": {
    "providers": [
      {
        "defaultGroups": ["users"]
      }
    ]
  }
}
```

This ensures LDAP users get at least the "users" group.

#### 3. Check Group Retrieval

Follow steps in [No Groups Retrieved](#no-groups-retrieved-from-ldap).

## Configuration Examples

### Example 1: Active Directory with Admin Mapping

`contents/config/platform.json`:
```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "active-directory",
        "url": "ldap://ad.example.com:389",
        "adminDn": "admin@example.com",
        "adminPassword": "${AD_PASSWORD}",
        "userSearchBase": "dc=example,dc=com",
        "usernameAttribute": "sAMAccountName",
        "groupSearchBase": "dc=example,dc=com",
        "groupClass": "group",
        "defaultGroups": ["users"]
      }
    ]
  }
}
```

`contents/config/groups.json`:
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
      "mappings": ["Domain Admins", "IT-Admins"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": ["Domain Users"]
    }
  }
}
```

### Example 2: OpenLDAP with Multiple Permission Levels

`contents/config/platform.json`:
```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "company-ldap",
        "url": "ldap://ldap.company.com:389",
        "userSearchBase": "ou=people,dc=company,dc=com",
        "groupSearchBase": "ou=groups,dc=company,dc=com",
        "groupClass": "groupOfNames"
      }
    ]
  }
}
```

`contents/config/groups.json`:
```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Platform-Admins", "IT-Management"]
    },
    "power-users": {
      "id": "power-users",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-3-opus"],
        "adminAccess": false
      },
      "mappings": ["Advanced-Users", "Developers"]
    },
    "users": {
      "id": "users",
      "permissions": {
        "apps": ["chat", "translator"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo"],
        "adminAccess": false
      },
      "mappings": ["All-Employees"]
    }
  }
}
```

## Debugging Tools

### Enable Debug Logging

Edit `contents/config/platform.json`:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

This provides much more detailed logging about group mapping.

### Check Groups Configuration

Validate JSON syntax:

```bash
cat contents/config/groups.json | jq .
```

If this command fails, your JSON is invalid.

### View Real-Time Logs

```bash
# Development
npm run dev

# Production
npm run logs

# Or view directly
tail -f logs/app.log
```

### Test LDAP Connection

Use `ldapsearch` to verify LDAP connectivity and group retrieval:

```bash
ldapsearch -x -H ldap://your-ldap-server:389 \
  -D "admin-dn" \
  -w "password" \
  -b "search-base" \
  "(uid=testuser)"
```

## FAQ

### Q: Are group names case-sensitive?

**A**: Yes! "IT-Admin" and "it-admin" are different. Use the exact case from LDAP.

### Q: Can one LDAP group map to multiple internal groups?

**A**: Yes! Add the same LDAP group name to multiple `mappings` arrays.

### Q: Can multiple LDAP groups map to one internal group?

**A**: Yes! List all LDAP groups in the same `mappings` array.

### Q: Do I need to restart the server after changing groups.json?

**A**: Usually no - the configuration hot-reloads. But if changes don't apply, restart the server.

### Q: What happens if a user is in multiple LDAP groups?

**A**: All matching internal groups are assigned. Permissions are merged.

### Q: What if a user has no mapped LDAP groups?

**A**: They get the "anonymous" group unless `defaultGroups` is configured in the LDAP provider.

### Q: Can I use wildcards in group mappings?

**A**: Not currently. Exact group names only.

### Q: How do I map admin roles for Active Directory?

**A**: Add Active Directory group names to the "admins" mappings:
```json
{
  "admins": {
    "mappings": ["Domain Admins", "Enterprise Admins", "IT-Admin"]
  }
}
```

## Getting Help

If you're still experiencing issues:

1. **Check the logs** - Look for `[LDAP Auth]` and `[Authorization]` entries
2. **Verify your configuration** - Ensure JSON is valid
3. **Test with `ldapsearch`** - Confirm LDAP server returns groups
4. **Review the concept document** - See `concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md`
5. **Check the main documentation** - See `docs/ldap-ntlm-authentication.md`

## Related Documentation

- [LDAP and NTLM Authentication Guide](ldap-ntlm-authentication.md)
- [Authentication Architecture](authentication-architecture.md)
- [Groups Configuration Reference](../server/defaults/config/groups.json)
