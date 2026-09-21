# LDAP and NTLM Authentication

This document describes how to configure and use LDAP and NTLM/Windows authentication in iHub Apps.

## Overview

iHub Apps supports enterprise authentication through:

- **LDAP Authentication**: Connect to LDAP servers including Active Directory
- **NTLM Authentication**: Windows Integrated Authentication using NTLM protocol

Both authentication methods integrate with the existing group-based permission system and support JWT token generation for stateless operation.

### Unified Login Support

As of version 4.2.0, the standard `/api/auth/login` endpoint supports both local and LDAP authentication automatically. This means:

- **Username/password forms work with LDAP** - When LDAP is the only authentication method enabled, users can log in using the standard login form
- **Automatic fallback** - The system tries local authentication first (if enabled), then automatically falls back to LDAP
- **Provider selection** - Users can optionally specify which LDAP provider to use when multiple are configured
- **Seamless user experience** - No need to know which authentication backend is being used

## LDAP Authentication

### Features

- Support for generic LDAP servers and Active Directory
- Multiple LDAP provider configurations
- Group mapping and inheritance
- Secure connection options (TLS/SSL)
- Flexible user search patterns

### Configuration

A provider needs three things: where the directory is, where its entries live,
and which kind of directory it is. Everything else is derived from those.

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate LDAP",
        "url": "ldap://ldap.example.com:389",
        "preset": "openldap",
        "baseDn": "dc=example,dc=org",
        "adminDn": "cn=admin,dc=example,dc=org",
        "adminPasswordRef": "ldap_corporate-ldap",
        "defaultGroups": ["ldap-users"]
      }
    ]
  }
}
```

That is the whole configuration. From `baseDn` and `preset`, iHub resolves:

| Resolved value             | For this example                       |
| -------------------------- | -------------------------------------- |
| `userSearchBase`           | `dc=example,dc=org`                    |
| `groupSearchBase`          | `dc=example,dc=org`                    |
| `usernameAttribute`        | `uid`                                  |
| `userDn`                   | `uid={{username}},dc=example,dc=org`   |
| `groupClass`               | `groupOfNames`                         |
| `groupMemberAttribute`     | `member`                               |
| `groupMemberUserAttribute` | `dn`                                   |

Any of them can still be set explicitly, and an explicit value always wins — so a
directory that keeps users and groups in separate subtrees just names those two:

```json
{
  "baseDn": "dc=example,dc=org",
  "userSearchBase": "ou=people,dc=example,dc=org",
  "groupSearchBase": "ou=groups,dc=example,dc=org"
}
```

> **Upgrading:** nothing changes for a provider that spells every field out.
> `baseDn` and `preset` are additions, not replacements, and a provider without
> them resolves exactly as it did before — including group search staying off
> when no `groupSearchBase` is set.

### Directory Presets

`preset` selects the attribute names that differ between directory products. It
never overrides a value you set yourself.

| Preset                     | `usernameAttribute` | `groupClass`   | id attributes                  | e-mail attributes         |
| -------------------------- | ------------------- | -------------- | ------------------------------ | ------------------------- |
| `openldap` (default)       | `uid`               | `groupOfNames` | `uid`, `sAMAccountName`, `cn`  | `mail`, `email`           |
| `activeDirectory`          | `sAMAccountName`    | `group`        | `sAMAccountName`, `uid`, `cn`  | `mail`, `userPrincipalName` |

Both presets use `member` / `dn` for group membership.

### Active Directory Configuration

```json
{
  "name": "active-directory",
  "displayName": "Active Directory",
  "url": "ldaps://ad.example.com:636",
  "preset": "activeDirectory",
  "baseDn": "dc=example,dc=com",
  "adminDn": "svc-ihub@example.com",
  "adminPasswordRef": "ldap_active-directory",
  "defaultGroups": ["ad-users"]
}
```

### Attribute Mapping

The user id, display name and e-mail come from the first LDAP attribute in the
preset's list that actually carries a value. Override a slot when the directory
uses something else — a single attribute name or an ordered list:

```json
{
  "attributeMapping": {
    "id": "employeeNumber",
    "email": ["mail", "userPrincipalName"]
  }
}
```

The connection test (below) reports which attribute each field was taken from.

### Bind Credentials

The bind password lives in the credential store, not in the provider: set
`adminPasswordRef` to the id of a credential profile (Admin → Credentials). The
profile's value may itself be an `${ENV_VAR}` placeholder or an `ENC[...]`
encrypted value. See [Value Encryption Tool](./value-encryption-tool.md).

Without `adminDn`, no service account is used and the user is bound directly as
`userDn`. Group membership is then only visible if the directory lets users
search it themselves.

### Testing a Login

Admin → Authentication → LDAP has a **Test a login** panel on every provider. It
runs the configuration that is currently in the form — saved or not — and
reports, step by step:

1. **Effective configuration** — every resolved value, and whether it was typed
   or derived
2. **Connect to directory** — TCP/TLS reachability, including certificate trust
3. **Bind and find the user** — the bind account and the entry that matched
4. **Verify the password** — only when a password is supplied
5. **Attributes read and mapped** — the entry's attributes, and which one became
   the id, the name and the e-mail
6. **LDAP groups** — the groups the directory returned
7. **Internal groups** — what those map to via `groups.json`, which LDAP groups
   have no mapping, and the final group list
8. **Resulting iHub user** — the user that would be created, and what it grants

The test creates no session, persists no user and issues no token. With a bind
account configured the password is optional: everything except step 4 can be
checked without knowing anyone's password.

The same run is available as an API call:

```bash
curl -X POST https://ihub.example.com/api/admin/auth/ldap/_test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providerName": "corporate-ldap", "username": "jdoe"}'
```

### Configuration Options

| Option                     | Description                                          | Required | Default                                              |
| -------------------------- | ---------------------------------------------------- | -------- | ---------------------------------------------------- |
| `name`                     | Unique identifier for the LDAP provider              | Yes      | -                                                    |
| `displayName`              | Human-readable name                                  | No       | Same as `name`                                       |
| `url`                      | LDAP server URL (ldap:// or ldaps://)                | Yes      | -                                                    |
| `preset`                   | `openldap` or `activeDirectory`                      | No       | `openldap`                                           |
| `baseDn`                   | Root DN of the directory                             | No\*     | -                                                    |
| `adminDn`                  | DN of the bind (service) account                     | No       | -                                                    |
| `adminPasswordRef`         | Id of the credential profile with the bind password  | No       | -                                                    |
| `userSearchBase`           | Base DN for user searches                            | No\*     | `baseDn`                                             |
| `usernameAttribute`        | Attribute to match username                          | No       | Preset (`uid` / `sAMAccountName`)                    |
| `userDn`                   | User DN template, used when no `adminDn` is set      | No       | `<usernameAttribute>={{username}},<userSearchBase>`  |
| `groupSearchBase`          | Base DN for group searches                           | No       | `baseDn`; without either, no groups are read         |
| `groupClass`               | LDAP class for groups                                | No       | Preset (`groupOfNames` / `group`)                    |
| `groupMemberAttribute`     | Group attribute listing members                      | No       | `member`                                             |
| `groupMemberUserAttribute` | User attribute that group entries reference          | No       | `dn`                                                 |
| `attributeMapping`         | Which attributes become id / name / email            | No       | Preset                                               |
| `defaultGroups`            | Default groups for authenticated users               | No       | `[]`                                                 |
| `sessionTimeoutMinutes`    | JWT token timeout                                    | No       | `480`                                                |
| `tlsOptions`               | TLS connection options                               | No       | `{}`                                                 |

\* Either `baseDn` or `userSearchBase` must be set.

## NTLM Authentication

### Features

- Windows Integrated Authentication
- Support for NTLM and Negotiate protocols
- Automatic user and group information extraction
- Domain-aware authentication
- JWT token generation for API access

### Configuration

Add NTLM configuration to your `contents/config/platform.json`:

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE",
    "domainController": "ldap://dc.example.com:389",
    "type": "ntlm",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "defaultGroups": ["ntlm-users"],
    "sessionTimeoutMinutes": 480,
    "generateJwtToken": true
  }
}
```

### Configuration Options

| Option                  | Description                                                    | Required | Default |
| ----------------------- | -------------------------------------------------------------- | -------- | ------- |
| `enabled`               | Enable NTLM authentication                                     | Yes      | `false` |
| `domain`                | Windows domain name                                            | No       | -       |
| `domainController`          | Domain controller URL (e.g., `ldap://dc.example.com:389`)      | No       | -       |
| `domainControllerUser`      | LDAP service account username for group lookup (optional)       | No       | -       |
| `domainControllerPassword`  | LDAP service account password for group lookup (optional)       | No       | -       |
| `type`                      | Authentication type (`ntlm` or `negotiate`)                     | No       | `ntlm`  |
| `debug`                 | Enable debug logging                                           | No       | `false` |
| `getUserInfo`           | Retrieve user information                                      | No       | `true`  |
| `getGroups`             | Retrieve user groups                                           | No       | `true`  |
| `defaultGroups`         | Default groups for authenticated users                         | No       | `[]`    |
| `sessionTimeoutMinutes` | JWT token timeout                                              | No       | `480`   |
| `generateJwtToken`      | Generate JWT for API access                                    | No       | `true`  |
| `ldapGroupLookupProvider` | Name of an LDAP provider to use for group lookup (see below) | No       | -       |

### LDAP Group Lookup for NTLM Users

NTLM authentication may not always return group memberships from the domain controller. As an alternative, you can configure NTLM to use an LDAP provider for group lookup. This allows NTLM to handle identity verification while LDAP provides group memberships.

#### How It Works

1. User authenticates via NTLM (identity verification)
2. During login, the system queries the configured LDAP provider for the user's group memberships using admin bind credentials (no user password needed)
3. LDAP groups are merged with any groups from NTLM and mapped to internal groups via `groups.json`

The LDAP group lookup only happens during login (session start), not on every request.

#### Configuration

1. Configure an LDAP provider in `ldapAuth.providers` with admin credentials and group search settings. Note: `ldapAuth.enabled` does not need to be `true` — the providers are accessible for group lookup regardless.

2. Set `ldapGroupLookupProvider` in your `ntlmAuth` config to the LDAP provider's `name`:

```json
{
  "ldapAuth": {
    "enabled": false,
    "providers": [
      {
        "name": "corporate-ad",
        "displayName": "Corporate Active Directory",
        "url": "ldap://ad.example.com:389",
        "preset": "activeDirectory",
        "baseDn": "dc=example,dc=com",
        "adminDn": "svc-ihub@example.com",
        "adminPasswordRef": "ldap_corporate-ad"
      }
    ]
  },
  "ntlmAuth": {
    "enabled": true,
    "domain": "EXAMPLE",
    "domainController": "ldap://dc.example.com:389",
    "ldapGroupLookupProvider": "corporate-ad",
    "defaultGroups": ["ntlm-users"],
    "generateJwtToken": true
  }
}
```

#### Requirements

- The LDAP provider **must** have `adminDn` and `adminPasswordRef` configured (admin bind is used since the user's password is not available during NTLM auth)
- The LDAP provider **must** have `baseDn` or `groupSearchBase` set, or no group membership is read
- The `usernameAttribute` must match the NTLM username format — `preset: "activeDirectory"` sets it to `sAMAccountName`

Use the provider's **Test a login** panel to confirm all three before relying on
it: with a bind account configured it needs no password, which is exactly the
situation NTLM group lookup runs in.

#### Graceful Fallback

If the LDAP group lookup fails for any reason (connection error, user not found, misconfiguration), NTLM authentication still succeeds. The user will be assigned groups from NTLM (if any) plus the configured `defaultGroups`.

### Platform Requirements

NTLM authentication has specific platform requirements:

- **Windows Server**: Best compatibility and full feature support
- **Linux/Unix**: Limited support, may require additional configuration
- **Network**: Direct connection required (no proxy support)

## Group Configuration

### Default Groups

The system includes predefined groups for LDAP and NTLM users:

```json
{
  "ldap-users": {
    "id": "ldap-users",
    "name": "LDAP Users",
    "description": "Default permissions for LDAP authenticated users",
    "inherits": ["authenticated"],
    "permissions": {
      "apps": ["translator", "summarizer"],
      "prompts": ["general", "writing"],
      "models": ["gpt-3.5-turbo", "gpt-4", "claude-4-sonnet"],
      "adminAccess": false
    }
  },
  "ntlm-users": {
    "id": "ntlm-users",
    "name": "NTLM Users",
    "description": "Default permissions for NTLM authenticated users",
    "inherits": ["authenticated"],
    "permissions": {
      "apps": ["chat", "translator", "email-composer"],
      "prompts": ["general", "writing"],
      "models": ["gpt-3.5-turbo", "gpt-4", "claude-4-sonnet"],
      "adminAccess": false
    }
  }
}
```

### Group Mapping

Both LDAP and NTLM support automatic group mapping. Groups from the authentication provider are mapped to internal groups using the `mappings` field in `contents/config/groups.json`.

#### How Group Mapping Works

1. **LDAP groups are extracted** during authentication from the `memberOf` attribute
2. **External groups are mapped** to internal groups using the `mappings` configuration
3. **Permissions are assigned** based on the user's internal groups
4. **Admin access is granted** if the user is in a group with `adminAccess: true`

#### Configuration Example

To map LDAP groups to the admin role, edit `contents/config/groups.json`:

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
      "mappings": ["IT-Admin", "IT-Admins", "Domain Admins", "Administrators"]
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

**Important Notes**:
- Group names are **case-sensitive** - "IT-Admin" ≠ "it-admin"
- Multiple LDAP groups can map to the same internal group
- One LDAP group can map to multiple internal groups
- The `mappings` array should contain exact LDAP group names

#### Assigning Admin Role via LDAP

To give admin access to users based on their LDAP group membership:

1. Add their LDAP group name to the `admins` group's `mappings` array
2. Ensure `"adminAccess": true` is set in the admins group permissions
3. Users in those LDAP groups will automatically get admin access

#### Troubleshooting Group Mapping

If group mapping isn't working:

1. **Check server logs** for group extraction and mapping information:
   ```
   [LDAP Auth] Extracted N LDAP groups for user: ["Group1", "Group2", ...]
   [LDAP Auth] Mapped N LDAP groups to M internal groups: ["admins", "users", ...]
   ```

2. **Verify LDAP groups are retrieved**:
   - Configure `groupSearchBase` in your LDAP provider
   - Set correct `groupClass` (e.g., `groupOfNames` for OpenLDAP, `group` for AD)

3. **Check for unmapped groups** in logs:
   ```
   [Authorization] External group "GroupName" has no mapping in groups configuration
   ```

4. **Ensure exact case match** - LDAP group names must match exactly in `mappings`

For detailed troubleshooting, see [LDAP Group Mapping Troubleshooting Guide](LDAP-GROUP-MAPPING-TROUBLESHOOTING.md).

## API Endpoints

### Universal Login (Recommended)

The `/api/auth/login` endpoint now supports both local and LDAP authentication automatically. It will try local authentication first (if enabled), then fall back to LDAP authentication.

#### Login with Auto-Detection

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "john.doe",
  "password": "password123"
}
```

#### Login with Specific LDAP Provider

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "john.doe",
  "password": "password123",
  "provider": "corporate-ldap"
}
```

**Note**: The `provider` parameter is optional. If not specified and multiple LDAP providers are configured, the system will try each provider until one succeeds.

#### Get Providers

```http
GET /api/auth/ldap/providers
```

### NTLM Authentication

#### Login (requires Windows authentication)

```http
POST /api/auth/ntlm/login
```

#### Status

```http
GET /api/auth/ntlm/status
```

### Authentication Status

Get information about all available authentication methods:

```http
GET /api/auth/status
```

## Client Integration

### JavaScript Example

```javascript
// Universal login (works with both local and LDAP)
async function login(username, password, provider = null) {
  const requestBody = { username, password };
  if (provider) {
    requestBody.provider = provider; // Optional: specify LDAP provider
  }

  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  const result = await response.json();
  if (result.success) {
    localStorage.setItem('auth_token', result.token);
    return result.user;
  }
  throw new Error(result.error);
}

// NTLM login (automatic with Windows authentication)
async function loginNtlm() {
  const response = await fetch('/api/auth/ntlm/login', {
    method: 'POST',
    credentials: 'include' // Important for NTLM
  });

  const result = await response.json();
  if (result.success) {
    localStorage.setItem('auth_token', result.token);
    return result.user;
  }
  throw new Error(result.error);
}

// Use token for API calls
async function makeAuthenticatedRequest(url) {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return response.json();
}
```

## Troubleshooting

### LDAP Issues

1. **Username/Password Form Not Showing (RESOLVED in v4.2.0)**
   - **Previous Issue**: When only LDAP was enabled, the username/password form would not appear
   - **Resolution**: The login form now appears when either local auth OR LDAP auth is enabled
   - **Note**: Upgrade to v4.2.0+ to use the unified login endpoint

2. **Connection Errors**
   - Verify LDAP server URL and port
   - Check network connectivity
   - Ensure TLS/SSL configuration is correct

3. **Authentication Failures**
   - Verify admin DN and password
   - Check user search base and username attribute
   - Test with a simple LDAP client (e.g., `ldapsearch`)
   - Check server logs for detailed error messages (with generic responses to clients for security)

3. **Group Mapping Issues**
   - Check group search base configuration
   - Verify group class setting
   - Review LDAP server logs

4. **Multiple LDAP Providers**
   - If you have multiple LDAP providers, the system will try each one in order
   - Optionally specify a provider using the `provider` parameter in the login request
   - Check logs to see which provider is being attempted

### NTLM Issues

1. **Not Working on Linux**
   - NTLM works best on Windows servers
   - Consider using Kerberos instead
   - Check domain configuration

2. **Connection Refused**
   - Ensure no proxy between client and server
   - Verify domain controller is accessible
   - Check Windows authentication settings

3. **Groups Not Retrieved**
   - Enable `getGroups` option
   - Check domain permissions
   - Review user account settings
   - Consider using `ldapGroupLookupProvider` to retrieve groups from an LDAP provider instead of the domain controller

### Common Issues

1. **JWT Token Errors**
   - Verify JWT secret configuration
   - Check token expiration settings
   - Ensure consistent JWT configuration

2. **Permission Denied**
   - Review group mappings
   - Check user group membership
   - Verify permissions configuration

## Security Considerations

### LDAP Security

- Use LDAPS (LDAP over SSL/TLS) for production
- Limit admin account permissions
- Use service accounts with minimal privileges
- Regularly rotate passwords

### NTLM Security

- NTLM is considered legacy; prefer Kerberos when possible
- Ensure secure network channels
- Monitor for NTLM relay attacks
- Use strong domain policies

### General Security

- Use strong JWT secrets
- Set appropriate token expiration times
- Monitor authentication logs
- Implement rate limiting
- Use HTTPS in production

## Dependencies

This feature requires the following npm packages:

```json
{
  "ldap-authentication": "^3.3.4",
  "express-ntlm": "^2.7.0"
}
```

## Compatibility

### LDAP Compatibility

- OpenLDAP
- Microsoft Active Directory
- Apache Directory Server
- Oracle Internet Directory
- IBM Security Directory Server

### NTLM Compatibility

- Windows Server 2016+
- Windows 10+
- Limited Linux support (testing required)

## Migration Guide

### From passport-ldapauth

The new implementation uses `ldap-authentication` instead of the deprecated `passport-ldapauth`. Update your configuration:

```javascript
// Old configuration
{
  server: {
    url: 'ldap://localhost:389',
    bindDN: 'cn=root',
    bindCredentials: 'secret',
    searchBase: 'ou=passport-ldapauth',
    searchFilter: '(uid={{username}})'
  }
}

// New configuration
{
  url: 'ldap://localhost:389',
  adminDn: 'cn=root',
  adminPassword: 'secret',
  userSearchBase: 'ou=passport-ldapauth',
  usernameAttribute: 'uid'
}
```

### From passport-windowsauth

The new NTLM implementation provides similar functionality with better maintenance:

```javascript
// Configuration remains similar
{
  domain: 'EXAMPLE',
  getUserInfo: true,
  getGroups: true
}
```
