# LDAP Group Lookup - Customer Quick Start Guide

## Overview

**Good News**: LDAP group lookup and admin role assignment already works in iHub Apps! 

Your customer can test LDAP group retrieval, and it works. Now they need to **configure the group mapping** in iHub Apps to assign admin roles based on LDAP groups.

## What's Already Working

✅ LDAP authentication  
✅ LDAP group extraction from directory  
✅ Group mapping system  
✅ Permission assignment based on groups  
✅ Admin role assignment via group membership  

## What Your Customer Needs to Do

### Step 1: Verify LDAP Configuration

Edit `contents/config/platform.json`:

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "url": "ldap://your-ldap-server:389",
        "adminDn": "cn=admin,dc=example,dc=org",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=people,dc=example,dc=org",
        "usernameAttribute": "uid",
        
        // IMPORTANT: These two lines must be configured for group retrieval
        "groupSearchBase": "ou=groups,dc=example,dc=org",
        "groupClass": "groupOfNames"  // or "group" for Active Directory
      }
    ]
  }
}
```

**Key Points**:
- `groupSearchBase`: Where LDAP groups are stored
- `groupClass`: Type of LDAP group objects
  - OpenLDAP: `groupOfNames` or `groupOfUniqueNames`
  - Active Directory: `group`

### Step 2: Configure Group Mappings

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
        "adminAccess": true  // This grants admin access
      },
      "mappings": [
        // Add YOUR LDAP admin group names here (case-sensitive!)
        "IT-Admin",
        "Administrators",
        "Domain Admins"
      ]
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
      "mappings": [
        // Add YOUR LDAP user group names here
        "Domain Users",
        "Employees"
      ]
    }
  }
}
```

**Key Points**:
- `mappings`: List of LDAP group names (exact match, case-sensitive)
- `adminAccess: true`: Required for admin panel access
- Add as many LDAP groups as needed to each mapping array

### Step 3: Test and Verify

1. **Restart the server** (if needed for config changes)

2. **Log in with an LDAP user** who is in an admin group

3. **Check server logs** for these entries:

```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["IT-Admin", "Employees", "VPN-Users"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["admins", "users"]
[Authorization] External group "IT-Admin" mapped to internal groups: ["admins"]
[Authorization] External group "Employees" mapped to internal groups: ["users"]
```

4. **Navigate to `/admin`** - user should have access

5. **Look for unmapped groups**:

```
[Authorization] External group "VPN-Users" has no mapping in groups configuration
```

Add these to `groups.json` if they should grant permissions.

## Troubleshooting

### Issue: No Groups Extracted

**Symptom**:
```
[LDAP Auth] No groups found in LDAP response for user john.doe
```

**Solution**:
- Add `groupSearchBase` to LDAP provider config
- Set correct `groupClass` for your LDAP server
- Verify user is in at least one LDAP group

### Issue: Groups Not Mapped

**Symptom**:
```
[Authorization] External group "IT-Admin" has no mapping in groups configuration
[Authorization] No groups mapped, assigning anonymous group
```

**Solution**:
- Add exact LDAP group names to `mappings` in `groups.json`
- Ensure case matches exactly
- Restart server after config changes

### Issue: Admin Access Not Working

**Symptoms**:
- User can log in
- User cannot access `/admin` route
- 403 Forbidden error

**Solution**:
- Verify user's LDAP group is in `admins` group `mappings`
- Check `adminAccess: true` is set in admins group
- Review logs to see which internal groups user was assigned

## Finding Your LDAP Group Names

Use `ldapsearch` to discover group names:

```bash
# Generic LDAP
ldapsearch -x -H ldap://ldap.example.com:389 \
  -D "cn=admin,dc=example,dc=org" \
  -w "password" \
  -b "ou=people,dc=example,dc=org" \
  "(uid=testuser)" memberOf

# Active Directory
ldapsearch -x -H ldap://ad.example.com:389 \
  -D "admin@example.com" \
  -w "password" \
  -b "dc=example,dc=com" \
  "(sAMAccountName=testuser)" memberOf
```

Copy the group names exactly as they appear.

## Example: Active Directory Setup

For Active Directory environments:

**Platform Configuration**:
```json
{
  "ldapAuth": {
    "providers": [
      {
        "name": "active-directory",
        "url": "ldap://ad.example.com:389",
        "adminDn": "admin@example.com",
        "adminPassword": "${AD_PASSWORD}",
        "userSearchBase": "dc=example,dc=com",
        "usernameAttribute": "sAMAccountName",
        "groupSearchBase": "dc=example,dc=com",
        "groupClass": "group"
      }
    ]
  }
}
```

**Groups Configuration**:
```json
{
  "admins": {
    "mappings": ["Domain Admins", "IT-Admin"]
  },
  "users": {
    "mappings": ["Domain Users"]
  }
}
```

## Enhanced Logging (New Feature)

We've added detailed logging to help troubleshoot group mapping:

**What's Logged**:
1. Number of LDAP groups extracted
2. Exact LDAP group names
3. Number of internal groups mapped
4. Which LDAP groups mapped to which internal groups
5. Warnings for unmapped groups with helpful guidance

**Enable Debug Logging** (optional for more details):
```json
{
  "logging": {
    "level": "debug"
  }
}
```

## Complete Documentation

For more details, see:

1. **Concept Document**: `concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md`
   - Complete architecture explanation
   - Configuration guide
   - Security best practices

2. **Troubleshooting Guide**: `docs/LDAP-GROUP-MAPPING-TROUBLESHOOTING.md`
   - Diagnostic steps
   - Common issues and solutions
   - Configuration examples

3. **Example Configurations**: `examples/config/ldap-group-mapping-example.md`
   - Working configurations for different scenarios
   - Active Directory examples
   - Multi-level permissions

4. **Main LDAP Documentation**: `docs/ldap-ntlm-authentication.md`
   - Complete LDAP authentication guide
   - Updated with group mapping section

## Summary

Your customer's LDAP group lookup already works. They just need to:

1. ✅ Ensure `groupSearchBase` is configured
2. ✅ Add their LDAP group names to `mappings` in `groups.json`
3. ✅ Test login and check logs
4. ✅ Verify admin access works

The enhanced logging will help them see exactly what's happening and quickly identify any configuration issues.

## Need Help?

If issues persist after following this guide:
1. Check server logs for the detailed group mapping information
2. Verify LDAP group names match exactly (case-sensitive)
3. Ensure LDAP server returns group information
4. Review the troubleshooting guide for specific error messages
