# NTLM and LDAP Primary Authentication Mode Support

**Date:** 2025-11-05  
**Status:** Implemented  
**Related Issue:** #500

## Overview

This document describes the implementation of NTLM and LDAP as primary authentication mode options in iHub Apps. Previously, while NTLM and LDAP authentication could be enabled and configured, they could not be set as the primary authentication mode (`auth.mode`). This limitation meant that administrators couldn't designate NTLM or LDAP as the default authentication method when multiple authentication methods were available.

## Problem Statement

When NTLM authentication was introduced and added to admin pages (PR #500), the primary authentication setting was missing. This setting is crucial for configuring the default authentication method, especially in deployments with multiple authentication methods enabled.

The `auth.mode` field in `platform.json` only supported:
- `proxy` - Authentication via reverse proxy or JWT tokens
- `local` - Built-in username/password authentication
- `oidc` - OpenID Connect with external providers
- `anonymous` - No authentication required

## Solution

### Backend Changes

#### Schema Validation (`server/validators/platformConfigSchema.js`)

1. **Extended auth.mode enum** to include 'ldap' and 'ntlm':
   ```javascript
   mode: z.enum(['proxy', 'local', 'oidc', 'ldap', 'ntlm', 'anonymous']).default('proxy')
   ```

2. **Added ldapProviderSchema** for LDAP provider configuration:
   ```javascript
   const ldapProviderSchema = z.object({
     name: z.string(),
     displayName: z.string(),
     url: z.string(),
     adminDn: z.string().optional(),
     adminPassword: z.string().optional(),
     userSearchBase: z.string(),
     usernameAttribute: z.string().default('uid'),
     userDn: z.string().optional(),
     groupSearchBase: z.string().optional(),
     groupClass: z.string().optional(),
     defaultGroups: z.array(z.string()).default([]),
     sessionTimeoutMinutes: z.number().min(1).default(480),
     tlsOptions: z.record(z.any()).optional()
   });
   ```

3. **Added ldapAuth schema** to the platform configuration schema:
   ```javascript
   ldapAuth: z.object({
     enabled: z.boolean().default(false),
     providers: z.array(ldapProviderSchema).default([])
   }).default({})
   ```

4. **Added ntlmAuth schema** to the platform configuration schema:
   ```javascript
   ntlmAuth: z.object({
     enabled: z.boolean().default(false),
     domain: z.string().optional(),
     domainController: z.string().optional(),
     type: z.enum(['ntlm', 'negotiate']).default('ntlm'),
     debug: z.boolean().default(false),
     getUserInfo: z.boolean().default(true),
     getGroups: z.boolean().default(true),
     defaultGroups: z.array(z.string()).default([]),
     sessionTimeoutMinutes: z.number().min(1).default(480),
     generateJwtToken: z.boolean().default(true),
     options: z.record(z.any()).optional()
   }).default({})
   ```

### Frontend Changes

#### Admin UI (`client/src/features/admin/components/PlatformFormEditor.jsx`)

1. **Added LDAP and NTLM mode options** to the primary authentication mode selector:
   ```javascript
   {
     mode: 'ldap',
     title: 'LDAP Mode',
     desc: 'LDAP/Active Directory authentication'
   },
   {
     mode: 'ntlm',
     title: 'NTLM Mode',
     desc: 'Windows Integrated Authentication (NTLM/Kerberos)'
   }
   ```

2. **Updated grid layout** from 4 columns to 3 columns to accommodate 6 authentication modes:
   - Row 1: Proxy, Local, OIDC
   - Row 2: LDAP, NTLM, Anonymous

## Primary Authentication Mode Behavior

The `auth.mode` setting determines:

1. **Default Authentication Flow**: Which authentication method users encounter first
2. **Authentication Routing**: How the application routes authentication requests
3. **Priority**: Which method takes precedence when multiple methods are enabled
4. **Unauthenticated Request Handling**: How the system responds to requests without authentication

## Configuration Examples

### NTLM as Primary Authentication

```json
{
  "auth": {
    "mode": "ntlm",
    "authenticatedGroup": "authenticated",
    "sessionTimeoutMinutes": 480
  },
  "ntlmAuth": {
    "enabled": true,
    "domain": "CORPORATE",
    "domainController": "dc.corporate.com",
    "type": "negotiate",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "defaultGroups": ["domain-users"],
    "sessionTimeoutMinutes": 480,
    "generateJwtToken": true
  }
}
```

### LDAP as Primary Authentication

```json
{
  "auth": {
    "mode": "ldap",
    "authenticatedGroup": "authenticated"
  },
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate LDAP",
        "url": "ldap://ldap.corporate.com:389",
        "adminDn": "cn=admin,dc=corporate,dc=com",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=people,dc=corporate,dc=com",
        "usernameAttribute": "uid",
        "groupSearchBase": "ou=groups,dc=corporate,dc=com",
        "groupClass": "groupOfNames",
        "defaultGroups": ["ldap-users"],
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

## Implementation Details

### Files Modified

1. `/server/validators/platformConfigSchema.js` - Backend schema validation
2. `/client/src/features/admin/components/PlatformFormEditor.jsx` - Admin UI form

### Related Code

- **NTLM Authentication Implementation**: `/server/middleware/ntlmAuth.js`
- **LDAP Authentication Implementation**: `/server/middleware/ldapAuth.js`
- **Authentication Routes**: `/server/routes/auth.js`
- **Admin Authentication Page**: `/client/src/features/admin/pages/AdminAuthPage.jsx`

## Testing

1. ✅ Schema validation accepts 'ntlm' and 'ldap' as valid auth.mode values
2. ✅ Server starts successfully with updated schema
3. ✅ Client builds without errors
4. ✅ Backend linting passes (no new errors)
5. ✅ Code review passed with no issues
6. ✅ Security scan passed with no vulnerabilities

## Backward Compatibility

This change is fully backward compatible. Existing configurations with auth.mode set to 'proxy', 'local', 'oidc', or 'anonymous' continue to work without modification.

## Future Enhancements

- Auto-detection of best available authentication method
- Fallback authentication chains (e.g., try NTLM first, then LDAP)
- Per-route authentication method specification
- Multi-factor authentication support

## References

- Issue #500: NTLM Primary Auth Mode missing
- PR #500: NTLM authentication introduction
- Authentication Concepts: `concepts/authentication-authorization-concept.md`
- External Authentication Integration: `concepts/2025-07-18 External Authentication Integration.md`
