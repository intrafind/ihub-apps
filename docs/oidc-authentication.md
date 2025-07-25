# OIDC Authentication

This document explains how to configure and use OpenID Connect (OIDC) authentication in AI Hub Apps.

## Overview

AI Hub Apps now supports OIDC authentication in addition to proxy and local authentication modes. OIDC enables integration with popular identity providers like Google, Microsoft, Auth0, and other OpenID Connect compliant providers.

## Features

- **Multiple Providers**: Support for multiple OIDC providers simultaneously
- **Secure Authentication**: JWT-based stateless authentication with secure token validation
- **User Group Mapping**: Map provider groups to internal permission groups
- **Seamless Integration**: Works alongside existing proxy and local authentication modes
- **Client-Side Support**: Complete frontend integration with provider selection

## Configuration

### 1. Platform Configuration

Enable OIDC in `contents/config/platform.json`:

```json
{
  "auth": {
    "mode": "oidc"
  },
  "anonymousAuth": {
    "enabled": false,
    "defaultGroups": ["anonymous"]
  },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "google",
        "displayName": "Google",
        "clientId": "${GOOGLE_CLIENT_ID}",
        "clientSecret": "${GOOGLE_CLIENT_SECRET}",
        "authorizationURL": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenURL": "https://www.googleapis.com/oauth2/v4/token",
        "userInfoURL": "https://www.googleapis.com/oauth2/v2/userinfo",
        "scope": ["openid", "profile", "email"],
        "callbackURL": "/api/auth/oidc/google/callback",
        "groupsAttribute": "groups",
        "pkce": true
      },
      {
        "name": "microsoft",
        "displayName": "Microsoft",
        "clientId": "${MICROSOFT_CLIENT_ID}",
        "clientSecret": "${MICROSOFT_CLIENT_SECRET}",
        "authorizationURL": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me",
        "scope": ["openid", "profile", "email", "User.Read"],
        "callbackURL": "/api/auth/oidc/microsoft/callback",
        "groupsAttribute": "groups",
        "pkce": true
      }
    ]
  }
}
```

### 2. Environment Variables

Set the required environment variables:

```bash
# JWT Secret (required for token signing)
JWT_SECRET=your-secure-jwt-secret

# OIDC Provider Configuration (optional, overrides platform.json)
OIDC_AUTH_ENABLED=true

# Group Configuration
AUTH_AUTHENTICATED_GROUP=authenticated

# Google Provider
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Microsoft Provider
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_CLIENT_SECRET=your-microsoft-client-secret

# Auth0 Provider (if using Auth0)
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret
AUTH0_DOMAIN=your-domain.auth0.com
```

### 3. Provider Configuration

Each OIDC provider requires the following configuration:

| Field              | Description                                         | Required                                       |
| ------------------ | --------------------------------------------------- | ---------------------------------------------- |
| `name`             | Unique provider identifier                          | Yes                                            |
| `displayName`      | Human-readable provider name                        | No                                             |
| `clientId`         | OAuth2 client ID                                    | Yes                                            |
| `clientSecret`     | OAuth2 client secret                                | Yes                                            |
| `authorizationURL` | Provider's authorization endpoint                   | Yes                                            |
| `tokenURL`         | Provider's token endpoint                           | Yes                                            |
| `userInfoURL`      | Provider's user info endpoint                       | Yes                                            |
| `scope`            | OAuth2 scopes to request                            | No (default: `["openid", "profile", "email"]`) |
| `callbackURL`      | Callback URL after authentication                   | No (auto-generated)                            |
| `groupsAttribute`  | User attribute containing group membership          | No                                             |
| `defaultGroups`    | Default groups assigned to users from this provider | No                                             |
| `pkce`             | Enable PKCE for enhanced security                   | No (default: `true`)                           |

## Provider Setup

### Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API
4. Create OAuth2 credentials:
   - Application type: Web application
   - Authorized redirect URIs: `https://yourdomain.com/api/auth/oidc/google/callback`
5. Copy Client ID and Client Secret

### Microsoft Azure AD

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to Azure Active Directory > App registrations
3. Create new registration:
   - Name: AI Hub Apps
   - Redirect URI: `https://yourdomain.com/api/auth/oidc/microsoft/callback`
4. Configure API permissions:
   - Microsoft Graph: `User.Read`, `openid`, `profile`, `email`
5. Copy Application (client) ID and create client secret

### Auth0

1. Go to [Auth0 Dashboard](https://manage.auth0.com/)
2. Create new application:
   - Type: Regular Web Application
3. Configure settings:
   - Allowed Callback URLs: `https://yourdomain.com/api/auth/oidc/auth0/callback`
   - Allowed Logout URLs: `https://yourdomain.com`
4. Copy Domain, Client ID, and Client Secret

## Group Assignment

AI Hub Apps provides flexible group assignment for OIDC users through multiple mechanisms:

### 1. Automatic Groups

Every authenticated user automatically receives these groups:

- **Authenticated Group**: All logged-in users get the `authenticated` group (configurable)
- **Provider Groups**: Users from each provider get provider-specific default groups

Configure in `contents/config/platform.json`:

```json
{
  "auth": {
    "authenticatedGroup": "authenticated"
  },
  "oidcAuth": {
    "providers": [
      {
        "name": "google",
        "defaultGroups": ["google-users", "external-users"]
      }
    ]
  }
}
```

### 2. Provider Groups from User Data

If your OIDC provider sends group information, configure the `groupsAttribute`:

```json
{
  "name": "microsoft",
  "groupsAttribute": "groups",
  "defaultGroups": ["microsoft-users"]
}
```

### 3. Group Mapping

Configure group mapping in `contents/config/groups.json`. External group mappings are now handled via the "mappings" arrays within each group definition:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Google Admins", "Microsoft Administrators", "Auth0 Admins"]
    },
    "user": {
      "id": "user",
      "name": "User",
      "description": "Standard user access to common applications",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Google Users", "Microsoft Users", "Everyone"]
    },
    "anonymous": {
      "id": "anonymous",
      "name": "Anonymous",
      "description": "Access for unauthenticated users",
      "permissions": {
        "apps": ["chat"],
        "prompts": [],
        "models": ["gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["anonymous"]
    }
  }
}
```

### 4. Final Group Assignment

The complete group assignment process for an OIDC user:

1. **Extract Groups**: Get groups from provider's `groupsAttribute` (if configured)
2. **Map Groups**: Apply group mapping from `groups.json` using the "mappings" arrays
3. **Add Provider Groups**: Add provider's `defaultGroups`
4. **Add Authenticated Group**: Add the global `authenticatedGroup`

**Example**: A Microsoft user with groups `["HR-Team", "Employees"]` would get:

- Original: `["HR-Team", "Employees"]`
- After mapping: `["hr", "user"]` (if "HR-Team" and "Employees" are in the mappings arrays)
- After provider groups: `["hr", "user", "microsoft-users"]`
- After authenticated group: `["hr", "user", "microsoft-users", "authenticated"]`

This ensures every OIDC user has at least the `authenticated` and provider-specific groups, even if the provider doesn't send group information.

### 5. Multi-Group Permission Aggregation

Users with multiple groups receive the **union of all permissions** from every group they belong to. The system uses Set aggregation to combine permissions without duplicates.

**Example Permission Aggregation**:

```javascript
// User groups: ["authenticated", "microsoft-users", "hr"]

// Individual group permissions:
// - authenticated: 5 apps, 4 models, 2 prompts
// - microsoft-users: 3 apps, 2 models, 2 prompts
// - hr: 4 apps, 2 models, 1 prompt

// Final aggregated permissions: 7 apps, 4 models, 3 prompts (union of all)
```

**Benefits for OIDC Users**:

- **Provider Groups**: Get baseline access through provider-specific groups
- **Authenticated Group**: Get additional access through the global authenticated group
- **Custom Groups**: Get specialized access through role-based groups
- **Additive Model**: More groups = more access, never conflicts

Set permissions in `contents/config/groups.json` (the same file that contains group mappings):

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Google Admins", "Microsoft Administrators", "Auth0 Admins"]
    },
    "user": {
      "id": "user",
      "name": "User",
      "description": "Standard user access to common applications",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Google Users", "Microsoft Users", "Everyone"]
    }
  }
}
```

## Authentication Flow

### 1. User Authentication

1. User clicks OIDC provider button in login form
2. Browser redirects to provider's authorization endpoint
3. User authenticates with provider
4. Provider redirects back to callback URL with authorization code
5. Server exchanges code for access token
6. Server fetches user information from provider
7. Server generates JWT token with user data and groups
8. Client receives JWT token and stores it

### 2. API Authentication

1. Client includes JWT token in Authorization header
2. Server validates JWT signature and expiration
3. Server extracts user information and permissions
4. Request proceeds with authenticated user context

## API Endpoints

### Get Available Providers

```http
GET /api/auth/oidc/providers
```

Returns list of configured OIDC providers.

### Initiate Authentication

```http
GET /api/auth/oidc/{provider}?returnUrl=optional
```

Redirects to provider's authorization endpoint.

### Authentication Callback

```http
GET /api/auth/oidc/{provider}/callback
```

Handles OAuth2 callback and issues JWT token.

### Authentication Status

```http
GET /api/auth/status
```

Returns current authentication configuration and user status.

## Client Integration

### Login Form

The login form automatically displays OIDC provider buttons when enabled:

```jsx
import { useAuth } from '../contexts/AuthContext';

function LoginForm() {
  const { loginWithOidc, authConfig } = useAuth();

  const handleOidcLogin = providerName => {
    loginWithOidc(providerName);
  };

  const providers = authConfig?.authMethods?.oidc?.providers || [];

  return (
    <div>
      {providers.map(provider => (
        <button key={provider.name} onClick={() => handleOidcLogin(provider.name)}>
          Sign in with {provider.displayName}
        </button>
      ))}
    </div>
  );
}
```

### Handling Callbacks

The AuthContext automatically handles OIDC callbacks:

```jsx
// AuthContext automatically detects and handles callback URLs
// No additional client-side code needed
```

## Security Considerations

1. **HTTPS Required**: Always use HTTPS in production
2. **Secure Secrets**: Store client secrets securely
3. **JWT Security**: Use strong JWT secrets (256-bit minimum)
4. **Token Expiration**: Configure appropriate session timeouts
5. **PKCE**: Enable PKCE for enhanced security
6. **Scope Limitation**: Request only necessary OAuth2 scopes

## Testing

### Local Development

1. Use localhost callback URLs during development
2. Most providers support localhost for testing
3. Ensure callback URLs match exactly

### Provider Configuration Test

```bash
# Test provider endpoint availability
curl https://accounts.google.com/.well-known/openid_configuration

# Test authentication status
curl http://localhost:3000/api/auth/status

# Test provider list
curl http://localhost:3000/api/auth/oidc/providers
```

## Troubleshooting

### Common Issues

1. **Invalid Callback URL**
   - Error: `redirect_uri_mismatch`
   - Solution: Ensure callback URLs match exactly in provider configuration

2. **Client Secret Not Found**
   - Error: `JWT secret not configured`
   - Solution: Set `JWT_SECRET` environment variable

3. **Provider Not Found**
   - Error: `OIDC provider 'name' not found`
   - Solution: Check provider configuration in `platform.json`

4. **Invalid Token**
   - Error: `JWT verification failed`
   - Solution: Check JWT secret consistency and token expiration

### Debug Mode

Enable debug logging:

```bash
DEBUG=auth:* npm start
```

## Migration from Other Auth Methods

### From Proxy Auth

1. Keep proxy configuration for backward compatibility
2. Add OIDC configuration
3. Users can choose authentication method
4. Gradually migrate users to OIDC

### From Local Auth

1. Export existing users if needed
2. Configure OIDC providers
3. Update group mappings
4. Inform users of new login process

## Best Practices

1. **Multiple Providers**: Configure multiple providers for redundancy
2. **Group Mapping**: Use consistent group naming across providers
3. **Session Management**: Configure appropriate session timeouts
4. **Monitoring**: Log authentication events for auditing
5. **Fallback**: Keep alternative authentication methods enabled
6. **Documentation**: Document provider setup for team members

## Example Configurations

### Enterprise Setup (Microsoft Only)

```json
{
  "auth": { "mode": "oidc" },
  "anonymousAuth": { "enabled": false },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "microsoft",
        "displayName": "Corporate Login",
        "clientId": "${MICROSOFT_CLIENT_ID}",
        "clientSecret": "${MICROSOFT_CLIENT_SECRET}",
        "authorizationURL": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me"
      }
    ]
  }
}
```

### Multi-Provider Setup

```json
{
  "auth": { "mode": "oidc" },
  "anonymousAuth": { "enabled": true },
  "oidcAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "google",
        "displayName": "Google",
        "clientId": "${GOOGLE_CLIENT_ID}",
        "clientSecret": "${GOOGLE_CLIENT_SECRET}",
        "authorizationURL": "https://accounts.google.com/o/oauth2/v2/auth",
        "tokenURL": "https://www.googleapis.com/oauth2/v4/token",
        "userInfoURL": "https://www.googleapis.com/oauth2/v2/userinfo"
      },
      {
        "name": "microsoft",
        "displayName": "Microsoft",
        "clientId": "${MICROSOFT_CLIENT_ID}",
        "clientSecret": "${MICROSOFT_CLIENT_SECRET}",
        "authorizationURL": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me"
      }
    ]
  }
}
```

## Implementation Status

✅ **Complete**:

- Core OIDC authentication flow
- Multiple provider support
- Client-side integration
- Group mapping and permissions
- JWT token generation and validation
- Security best practices

The OIDC implementation is production-ready and can be used alongside existing authentication methods.
