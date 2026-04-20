# ADFS Authentication Guide

This guide explains how to configure Active Directory Federation Services (ADFS) as an authentication provider for iHub Apps using the OpenID Connect (OIDC) protocol.

## Overview

ADFS 2.0 and later versions support OpenID Connect (OIDC), making them compatible with iHub Apps' existing OIDC authentication mode. No additional code or plugins are required - you simply configure ADFS as an OIDC provider.

**Benefits of ADFS with iHub Apps:**
- Single Sign-On (SSO) for domain users
- Multi-factor authentication support
- Centralized user management through Active Directory
- Standards-based authentication (OAuth2/OIDC)
- Group-based permissions mapping
- Cloud and on-premises compatibility

## Prerequisites

Before configuring ADFS authentication in iHub Apps:

1. **ADFS Server**: ADFS 2.0 or later installed and configured
2. **Active Directory**: ADFS connected to your Active Directory
3. **Network Access**: iHub Apps server can reach ADFS endpoints
4. **HTTPS**: Both ADFS and iHub Apps should use HTTPS in production
5. **Administrator Access**: ADFS administrator privileges to configure applications

## ADFS Server Configuration

### Step 1: Create Application Group in ADFS

1. Open **ADFS Management Console** on your ADFS server

2. Navigate to **Application Groups** → Right-click → **Add Application Group**

3. In the Add Application Group Wizard:
   - **Name**: `iHub Apps`
   - **Template**: Select **Web browser accessing a web application**
   - Click **Next**

4. Configure the **Server Application**:
   - **Name**: `iHub Apps Web Application`
   - **Redirect URI**: `https://yourdomain.com/api/auth/oidc/adfs/callback`
     - Replace `yourdomain.com` with your actual iHub Apps domain
     - For development: `http://localhost:5173/api/auth/oidc/adfs/callback`
   - **Note the Client Identifier** (you'll need this as `ADFS_CLIENT_ID`)
   - Click **Next**

5. **Generate Shared Secret**:
   - Click **Generate a shared secret**
   - **Important**: Copy and save this secret immediately (you'll need it as `ADFS_CLIENT_SECRET`)
   - This secret cannot be retrieved later
   - Click **Next**

6. Review and click **Next**, then **Close**

### Step 2: Configure Issuance Transform Rules

1. In ADFS Management, right-click your **iHub Apps** application group → **Properties**

2. Select the **Web application** component → Click **Edit**

3. Go to **Issuance Transform Rules** tab → **Add Rule**

4. **Add Email Claim Rule**:
   - **Claim rule template**: `Send LDAP Attributes as Claims`
   - **Claim rule name**: `Send Email`
   - **Attribute store**: `Active Directory`
   - **Mapping**:
     - LDAP Attribute: `E-Mail-Addresses` → Outgoing Claim Type: `E-Mail Address`
     - LDAP Attribute: `Display-Name` → Outgoing Claim Type: `Name`
   - Click **Finish**

5. **Add Group Membership Rule** (if you want to map AD groups):
   - Click **Add Rule** again
   - **Claim rule template**: `Send Group Membership as a Claim`
   - **Claim rule name**: `Send AD Groups`
   - **User's group**: Select your AD group (e.g., `Domain Users`)
   - **Outgoing claim type**: `Group`
   - **Outgoing claim value**: `users` (or your group name)
   - Click **Finish**
   - Repeat for each group you want to map

6. **Add Custom Group Claim** (alternative method for all groups):
   ```
   # Custom claim rule to send all AD groups
   c:[Type == "http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname", Issuer == "AD AUTHORITY"]
   => issue(store = "Active Directory",
           types = ("http://schemas.xmlsoap.org/claims/Group"),
           query = ";tokenGroups;{0}",
           param = c.Value);
   ```

### Step 3: Get ADFS Endpoints

Use the OIDC discovery endpoint to verify configuration:

```bash
# Replace with your ADFS server URL
curl https://adfs.yourdomain.com/adfs/.well-known/openid-configuration
```

**Typical ADFS Endpoints:**
- **Discovery**: `https://adfs.yourdomain.com/adfs/.well-known/openid-configuration`
- **Authorization**: `https://adfs.yourdomain.com/adfs/oauth2/authorize`
- **Token**: `https://adfs.yourdomain.com/adfs/oauth2/token`
- **UserInfo**: `https://adfs.yourdomain.com/adfs/oauth2/userinfo`
- **Logout**: `https://adfs.yourdomain.com/adfs/oauth2/logout`

## iHub Apps Configuration

### Step 1: Set Environment Variables

Add ADFS credentials to your `.env` file:

```bash
# ADFS Authentication
ADFS_CLIENT_ID=your-adfs-client-identifier-from-step-1
ADFS_CLIENT_SECRET=your-adfs-client-secret-from-step-1
```

**Security Note**: Never commit the `.env` file to version control. Use environment variables or secure secret management in production.

### Step 2: Configure Platform Settings

Edit `contents/config/platform.json` to add ADFS as an OIDC provider:

```json
{
  "auth": {
    "mode": "oidc",
    "authenticatedGroup": "authenticated",
    "sessionTimeoutMinutes": 480
  },
  "anonymousAuth": {
    "enabled": false,
    "defaultGroups": ["anonymous"]
  },
  "oidcAuth": {
    "enabled": true,
    "allowSelfSignup": true,
    "providers": [
      {
        "name": "adfs",
        "displayName": "Corporate Login",
        "clientId": "${ADFS_CLIENT_ID}",
        "clientSecret": "${ADFS_CLIENT_SECRET}",
        "authorizationURL": "https://adfs.yourdomain.com/adfs/oauth2/authorize",
        "tokenURL": "https://adfs.yourdomain.com/adfs/oauth2/token",
        "userInfoURL": "https://adfs.yourdomain.com/adfs/oauth2/userinfo",
        "scope": ["openid", "profile", "email"],
        "callbackURL": "https://yourdomain.com/api/auth/oidc/adfs/callback",
        "groupsAttribute": "groups",
        "defaultGroups": ["authenticated"],
        "pkce": true,
        "enabled": true
      }
    ]
  }
}
```

**Configuration Parameters:**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `name` | Unique provider identifier (lowercase) | `adfs` |
| `displayName` | Name shown on login button | `Corporate Login` |
| `clientId` | ADFS client identifier from Step 1 | `${ADFS_CLIENT_ID}` |
| `clientSecret` | ADFS client secret from Step 1 | `${ADFS_CLIENT_SECRET}` |
| `authorizationURL` | ADFS authorization endpoint | `https://adfs.yourdomain.com/adfs/oauth2/authorize` |
| `tokenURL` | ADFS token endpoint | `https://adfs.yourdomain.com/adfs/oauth2/token` |
| `userInfoURL` | ADFS userinfo endpoint | `https://adfs.yourdomain.com/adfs/oauth2/userinfo` |
| `scope` | OIDC scopes to request | `["openid", "profile", "email"]` |
| `callbackURL` | Where ADFS redirects after auth | `https://yourdomain.com/api/auth/oidc/adfs/callback` |
| `groupsAttribute` | Claim containing group membership | `groups` or `group` |
| `defaultGroups` | Groups assigned to all ADFS users | `["authenticated"]` |
| `pkce` | Enable PKCE for enhanced security | `true` |
| `enabled` | Enable/disable this provider | `true` |

### Step 3: Configure Group Mappings

Map ADFS/Active Directory groups to iHub Apps permissions in `contents/config/groups.json`:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Administrators",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Domain Admins", "IT-Admin", "ADFS-Administrators", "App-Admins"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user access to applications",
      "inherits": ["authenticated"],
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general", "technical"],
        "models": ["gpt-3.5-turbo", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Domain Users", "ADFS-Users", "Employees", "Everyone"]
    },
    "authenticated": {
      "id": "authenticated",
      "name": "Authenticated",
      "description": "Base permissions for all authenticated users",
      "permissions": {
        "apps": ["chat"],
        "prompts": [],
        "models": ["gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["authenticated"]
    }
  }
}
```

**Group Mapping Logic:**

1. **Extract Groups**: iHub Apps retrieves groups from the `groupsAttribute` claim in the ADFS token
2. **Map to Internal Groups**: External group names are matched against the `mappings` arrays
3. **Add Provider Groups**: Provider-specific `defaultGroups` are added
4. **Add Authenticated Group**: The global `authenticatedGroup` is added
5. **Merge Permissions**: User gets the union of all permissions from all groups

**Example**: User in AD groups `["Domain Users", "IT-Admin"]`:
- Matched mappings: `users`, `admin`
- Default groups: `authenticated`
- Final groups: `["users", "admin", "authenticated"]`
- Permissions: Union of all three groups (including admin access)

### Step 4: Restart iHub Apps

```bash
# Restart the server to load new configuration
npm run start:prod

# Or if using PM2
pm2 restart ihub-apps

# Or if using Docker
docker-compose restart
```

## Testing the Configuration

### 1. Verify ADFS Endpoints

```bash
# Test OIDC discovery endpoint
curl https://adfs.yourdomain.com/adfs/.well-known/openid-configuration

# Should return JSON with endpoints and configuration
```

### 2. Test iHub Apps OIDC Configuration

```bash
# Get available authentication providers
curl http://localhost:3000/api/auth/status

# Should show ADFS provider in authMethods.oidc.providers
```

### 3. Test Authentication Flow

1. Navigate to iHub Apps login page: `https://yourdomain.com/login`
2. Click **Corporate Login** (or your configured `displayName`)
3. You should be redirected to ADFS login page
4. Enter your Active Directory credentials
5. After successful authentication, you should be redirected back to iHub Apps
6. Verify you can access applications based on your group permissions

### 4. Verify User Information

After logging in, check the browser console or make an API request:

```javascript
// In browser console
fetch('/api/auth/status', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log)

// Expected response includes:
// - user.id (from ADFS)
// - user.email
// - user.groups (mapped groups)
// - user.permissions (aggregated from groups)
```

## Troubleshooting

### Common Issues

#### 1. "Invalid redirect URI" Error

**Symptom**: ADFS shows error about redirect URI mismatch

**Solution**:
- Verify the callback URL in `platform.json` matches EXACTLY what's configured in ADFS
- Check for trailing slashes (must match exactly)
- Verify protocol (http vs https)
- Development: Use `http://localhost:5173/api/auth/oidc/adfs/callback`
- Production: Use `https://yourdomain.com/api/auth/oidc/adfs/callback`

#### 2. "Client authentication failed" Error

**Symptom**: Token exchange fails with client authentication error

**Solution**:
- Verify `ADFS_CLIENT_ID` matches the client identifier from ADFS
- Verify `ADFS_CLIENT_SECRET` is correct (regenerate if needed)
- Check that environment variables are loaded correctly
- Ensure no extra spaces in `.env` file

#### 3. Groups Not Appearing

**Symptom**: User authenticates but has no groups or wrong permissions

**Solution**:
- Verify issuance transform rules are configured in ADFS
- Check the `groupsAttribute` matches the claim name in ADFS token
- Common claim names: `groups`, `group`, `roles`, `http://schemas.xmlsoap.org/claims/Group`
- Enable auth debug logging to see what claims are received:
  ```json
  {
    "auth": {
      "debug": {
        "enabled": true,
        "providers": {
          "oidc": { "enabled": true }
        }
      }
    }
  }
  ```
- Check server logs for group extraction messages

#### 4. Token Validation Errors

**Symptom**: "JWT verification failed" or token signature errors

**Solution**:
- Verify iHub Apps can access ADFS metadata endpoint
- Check that JWT algorithm matches (RS256 is standard)
- Ensure system clocks are synchronized (NTP)
- Verify SSL certificates are valid and trusted

#### 5. Login Loop

**Symptom**: User gets redirected back to login after authentication

**Solution**:
- Check session timeout settings
- Verify JWT secret is configured (iHub Apps auto-generates RSA keys)
- Ensure cookies are enabled in browser
- Check that callback URL is correctly configured
- Verify HTTPS is used in production

### Debug Mode

Enable detailed authentication logging:

```json
{
  "auth": {
    "debug": {
      "enabled": true,
      "maskTokens": true,
      "redactPasswords": true,
      "includeRawData": false,
      "providers": {
        "oidc": { "enabled": true }
      }
    }
  },
  "logging": {
    "level": "debug"
  }
}
```

View logs:

```bash
# If using PM2
pm2 logs ihub-apps

# If running directly
npm run logs

# Or check server console output
```

## Multi-Provider Configuration

You can configure ADFS alongside other authentication providers:

```json
{
  "auth": {
    "mode": "oidc"
  },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "adfs",
        "displayName": "Corporate Login (ADFS)",
        "clientId": "${ADFS_CLIENT_ID}",
        "clientSecret": "${ADFS_CLIENT_SECRET}",
        "authorizationURL": "https://adfs.yourdomain.com/adfs/oauth2/authorize",
        "tokenURL": "https://adfs.yourdomain.com/adfs/oauth2/token",
        "userInfoURL": "https://adfs.yourdomain.com/adfs/oauth2/userinfo",
        "scope": ["openid", "profile", "email"],
        "enabled": true
      },
      {
        "name": "microsoft",
        "displayName": "Microsoft Account",
        "clientId": "${MICROSOFT_CLIENT_ID}",
        "clientSecret": "${MICROSOFT_CLIENT_SECRET}",
        "authorizationURL": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me",
        "enabled": true
      }
    ]
  }
}
```

Users will see multiple login buttons and can choose their preferred provider.

## Migration from NTLM

If you're migrating from NTLM to ADFS:

### Migration Strategy

1. **Phase 1: Parallel Operation**
   ```json
   {
     "auth": {
       "mode": "oidc"
     },
     "ntlmAuth": {
       "enabled": true,
       "type": "ntlm"
     },
     "oidcAuth": {
       "enabled": true,
       "providers": [{ /* ADFS config */ }]
     }
   }
   ```

2. **Phase 2: User Migration**
   - Inform users about new ADFS login option
   - Encourage users to try ADFS authentication
   - Monitor authentication logs for adoption

3. **Phase 3: NTLM Deprecation**
   ```json
   {
     "auth": {
       "mode": "oidc"
     },
     "ntlmAuth": {
       "enabled": false
     }
   }
   ```

### Group Mapping Migration

Map existing NTLM groups to ADFS groups:

```json
{
  "groups": {
    "users": {
      "id": "users",
      "name": "Users",
      "permissions": { /* same as before */ },
      "mappings": [
        "Domain Users",      // NTLM group
        "ADFS-Users",        // ADFS group
        "Everyone"           // Both
      ]
    }
  }
}
```

## Security Best Practices

### 1. Use HTTPS in Production

```json
{
  "authorizationURL": "https://adfs.yourdomain.com/adfs/oauth2/authorize",
  "tokenURL": "https://adfs.yourdomain.com/adfs/oauth2/token",
  "userInfoURL": "https://adfs.yourdomain.com/adfs/oauth2/userinfo",
  "callbackURL": "https://yourdomain.com/api/auth/oidc/adfs/callback"
}
```

### 2. Enable PKCE

```json
{
  "pkce": true
}
```

PKCE (Proof Key for Code Exchange) provides additional security for the OAuth2 flow.

### 3. Secure Client Secrets

- Store in environment variables (not in `platform.json`)
- Use iHub Apps admin UI for encrypted storage
- Rotate secrets periodically
- Never commit secrets to version control

### 4. Configure Session Timeouts

```json
{
  "auth": {
    "sessionTimeoutMinutes": 480
  }
}
```

### 5. Enable Multi-Factor Authentication

Configure MFA in ADFS:
1. ADFS Management Console → **Authentication Policies**
2. Configure **Multi-factor Authentication** rules
3. Users will be prompted for MFA during login

### 6. Monitor Authentication Logs

```bash
# Enable detailed logging
npm run logs

# Monitor for suspicious activity:
# - Multiple failed login attempts
# - Logins from unexpected locations
# - Token validation failures
```

## Advanced Configuration

### Custom Claims Mapping

Map custom ADFS claims to user attributes:

```json
{
  "oidcAuth": {
    "providers": [
      {
        "name": "adfs",
        "groupsAttribute": "groups",
        "customAttributeMapping": {
          "department": "department",
          "title": "jobtitle",
          "manager": "manager"
        }
      }
    ]
  }
}
```

### Conditional Access

Use ADFS conditional access policies:
- IP-based restrictions
- Device compliance requirements
- Time-based access control
- Risk-based authentication

### Single Logout

Configure logout URL in ADFS:

```json
{
  "oidcAuth": {
    "providers": [
      {
        "name": "adfs",
        "logoutURL": "https://adfs.yourdomain.com/adfs/oauth2/logout"
      }
    ]
  }
}
```

## Further Reading

- [OIDC Authentication Guide](./oidc-authentication.md) - General OIDC configuration
- [Authentication Architecture](./authentication-architecture.md) - Overall auth system design
- [Security Guide](./security.md) - Security best practices
- [Microsoft ADFS Documentation](https://docs.microsoft.com/en-us/windows-server/identity/ad-fs/ad-fs-overview)
- [OpenID Connect Specification](https://openid.net/connect/)

## Support

If you encounter issues not covered in this guide:

1. Enable debug logging and check server logs
2. Verify ADFS configuration in ADFS Management Console
3. Test ADFS endpoints directly (use curl or Postman)
4. Check browser console for client-side errors
5. Consult the [Troubleshooting](#troubleshooting) section
6. Review the [OIDC Authentication Guide](./oidc-authentication.md)
