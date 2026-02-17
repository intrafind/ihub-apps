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

Add LDAP configuration to your `contents/config/platform.json`:

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
        "defaultGroups": ["ldap-users"],
        "sessionTimeoutMinutes": 480,
        "tlsOptions": {
          "rejectUnauthorized": false
        }
      }
    ]
  }
}
```

### Active Directory Configuration

For Active Directory, use this configuration pattern:

```json
{
  "name": "active-directory",
  "displayName": "Active Directory",
  "url": "ldap://ad.example.com:389",
  "adminDn": "${AD_BIND_USER}@example.com",
  "adminPassword": "${AD_BIND_PASSWORD}",
  "userSearchBase": "dc=example,dc=com",
  "usernameAttribute": "sAMAccountName",
  "userDn": "{{username}}@example.com",
  "groupSearchBase": "dc=example,dc=com",
  "groupClass": "group",
  "defaultGroups": ["ad-users"],
  "sessionTimeoutMinutes": 480
}
```

### Environment Variables

Set these environment variables for LDAP authentication:

```bash
# For generic LDAP
LDAP_ADMIN_PASSWORD=your_ldap_admin_password

# For Active Directory
AD_BIND_USER=your_ad_service_account
AD_BIND_PASSWORD=your_ad_service_password
```

### Configuration Options

| Option                  | Description                                    | Required | Default                                        |
| ----------------------- | ---------------------------------------------- | -------- | ---------------------------------------------- |
| `name`                  | Unique identifier for the LDAP provider        | Yes      | -                                              |
| `displayName`           | Human-readable name                            | No       | Same as `name`                                 |
| `url`                   | LDAP server URL (ldap:// or ldaps://)          | Yes      | -                                              |
| `adminDn`               | DN for binding to LDAP (if required)           | No       | -                                              |
| `adminPassword`         | Password for admin binding                     | No       | -                                              |
| `userSearchBase`        | Base DN for user searches                      | Yes      | -                                              |
| `usernameAttribute`     | Attribute to match username                    | No       | `uid`                                          |
| `userDn`                | Pattern for user DN ({{username}} placeholder) | No       | `uid={{username}},ou=people,dc=example,dc=org` |
| `groupSearchBase`       | Base DN for group searches                     | No       | -                                              |
| `groupClass`            | LDAP class for groups                          | No       | `groupOfNames`                                 |
| `defaultGroups`         | Default groups for authenticated users         | No       | `[]`                                           |
| `sessionTimeoutMinutes` | JWT token timeout                              | No       | `480`                                          |
| `tlsOptions`            | TLS connection options                         | No       | `{}`                                           |

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
| `domainController`      | Domain controller URL (e.g., `ldap://dc.example.com:389`)      | No       | -       |
| `type`                  | Authentication type (`ntlm` or `negotiate`)                    | No       | `ntlm`  |
| `debug`                 | Enable debug logging                                           | No       | `false` |
| `getUserInfo`           | Retrieve user information                                      | No       | `true`  |
| `getGroups`             | Retrieve user groups                                           | No       | `true`  |
| `defaultGroups`         | Default groups for authenticated users                         | No       | `[]`    |
| `sessionTimeoutMinutes` | JWT token timeout                                              | No       | `480`   |
| `generateJwtToken`      | Generate JWT for API access                                    | No       | `true`  |

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
  "express-ntlm": "^2.6.0",
  "passport-ntlm": "^1.0.1"
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
