# LDAP and NTLM Authentication

This document describes how to configure and use LDAP and NTLM/Windows authentication in iHub Apps.

## Overview

iHub Apps supports enterprise authentication through:

- **LDAP Authentication**: Connect to LDAP servers including Active Directory
- **NTLM Authentication**: Windows Integrated Authentication using NTLM protocol

Both authentication methods integrate with the existing group-based permission system and support JWT token generation for stateless operation.

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

#### Encrypting Passwords (Recommended)

For enhanced security, you should encrypt sensitive values like passwords before storing them in the `.env` file:

1. **Generate an encrypted value** using the encryption tool:
   ```bash
   node server/utils/encryptEnvValue.js "your_ldap_admin_password"
   ```

2. **Copy the encrypted value** (starts with `ENC[`) from the output

3. **Add it to your `.env` file**:
   ```bash
   LDAP_ADMIN_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
   ```

4. The system will **automatically decrypt** the value when loading the configuration

**Important Notes:**
- Keep your `TOKEN_ENCRYPTION_KEY` secure and consistent. If you lose or change it, encrypted values will need to be re-encrypted.
- The encryption key is automatically generated on first run if not set. Set it explicitly in production:
  ```bash
  TOKEN_ENCRYPTION_KEY=your_64_character_hex_key
  ```
- You can generate a secure key with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- All environment variables (API keys, passwords, etc.) can be encrypted using this method

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

Both LDAP and NTLM support automatic group mapping. Groups from the authentication provider are mapped to internal groups using the `mappings` field:

```json
{
  "ad-users": {
    "mappings": ["Domain Users", "Employees", "Staff"]
  }
}
```

## API Endpoints

### LDAP Authentication

#### Login

```http
POST /api/auth/ldap/login
Content-Type: application/json

{
  "username": "john.doe",
  "password": "password123",
  "provider": "corporate-ldap"
}
```

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
// LDAP login
async function loginLdap(username, password, provider) {
  const response = await fetch('/api/auth/ldap/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password, provider })
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

1. **Connection Errors**
   - Verify LDAP server URL and port
   - Check network connectivity
   - Ensure TLS/SSL configuration is correct

2. **Authentication Failures**
   - Verify admin DN and password
   - Check user search base and username attribute
   - Test with a simple LDAP client (e.g., `ldapsearch`)

3. **Group Mapping Issues**
   - Check group search base configuration
   - Verify group class setting
   - Review LDAP server logs

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
