# JWT Authentication

The iHub Apps platform supports **external JWT authentication**, allowing systems with existing JWT providers to integrate seamlessly without implementing OIDC flows. This enables direct API access using pre-issued JWT tokens.

## Overview

JWT (JSON Web Token) authentication allows external systems to:

- Use their existing JWT token provider
- Make direct API calls without authentication redirects
- Integrate with existing identity and access management systems
- Bypass the need for OIDC handshake flows

## How It Works

1. **External System**: Issues JWT tokens to users/systems
2. **Client**: Makes API calls with `Authorization: Bearer <jwt-token>` header
3. **iHub**: Validates JWT against external provider's public keys
4. **Access**: Grants access based on token claims and group mappings

## Configuration

### 1. Platform Configuration

Add JWT providers to your `contents/config/platform.json`:

```json
{
  "auth": {
    "mode": "proxy"
  },
  "anonymousAuth": {
    "enabled": false
  },
  "proxyAuth": {
    "enabled": true,
    "jwtProviders": [
      {
        "name": "my-jwt-provider",
        "header": "Authorization",
        "issuer": "https://my-jwt-provider.com",
        "audience": "ihub-apps",
        "jwkUrl": "https://my-jwt-provider.com/.well-known/jwks.json"
      }
    ]
  }
}
```

### 2. JWT Provider Configuration

| Field      | Description                          | Required | Example                                            |
| ---------- | ------------------------------------ | -------- | -------------------------------------------------- |
| `name`     | Unique identifier for the provider   | Yes      | `"company-jwt"`                                    |
| `header`   | HTTP header containing the JWT token | Yes      | `"Authorization"`                                  |
| `issuer`   | Expected `iss` claim in JWT          | Yes      | `"https://auth.company.com"`                       |
| `audience` | Expected `aud` claim in JWT          | Yes      | `"ihub-apps"`                                    |
| `jwkUrl`   | URL to fetch JSON Web Key Set        | Yes      | `"https://auth.company.com/.well-known/jwks.json"` |

## JWT Token Requirements

### Required Claims

Your JWT tokens must include these standard claims:

```json
{
  "iss": "https://my-jwt-provider.com",
  "aud": "ihub-apps",
  "exp": 1703980800,
  "iat": 1703977200,
  "sub": "user123"
}
```

### User Identity Claims (one required)

The system will use the first available claim for user identification:

- `preferred_username` - Preferred username
- `upn` - User Principal Name (Microsoft)
- `email` - Email address
- `sub` - Subject (fallback)

### Optional Claims

```json
{
  "groups": ["users", "admins"],
  "name": "John Doe",
  "email": "john@company.com"
}
```

### Technical Requirements

- **Algorithm**: RS256 (asymmetric signing)
- **Key Distribution**: JWKs endpoint required
- **Token Format**: Standard JWT structure
- **Signature**: Must be verifiable with provider's public keys

## API Usage Examples

### Basic API Call

```bash
curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
     https://your-ihub.com/api/apps
```

### Custom Header (if configured)

```bash
curl -H "X-JWT-Token: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
     https://your-ihub.com/api/apps
```

### JavaScript Example

```javascript
const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...';

const response = await fetch('/api/apps', {
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

const apps = await response.json();
```

## Configuration Examples

### Example 1: Auth0 Integration

```json
{
  "name": "auth0",
  "header": "Authorization",
  "issuer": "https://company.auth0.com/",
  "audience": "ihub-apps",
  "jwkUrl": "https://company.auth0.com/.well-known/jwks.json"
}
```

### Example 2: Azure AD Integration

```json
{
  "name": "azure-ad",
  "header": "Authorization",
  "issuer": "https://sts.windows.net/tenant-id/",
  "audience": "api://ihub-apps",
  "jwkUrl": "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys"
}
```

### Example 3: Custom JWT Provider

```json
{
  "name": "internal-auth",
  "header": "X-Auth-Token",
  "issuer": "https://internal-auth.company.com",
  "audience": "ihub-apps",
  "jwkUrl": "https://internal-auth.company.com/jwks"
}
```

### Example 4: Multiple Providers

```json
{
  "jwtProviders": [
    {
      "name": "auth0",
      "header": "Authorization",
      "issuer": "https://company.auth0.com/",
      "audience": "ihub-apps",
      "jwkUrl": "https://company.auth0.com/.well-known/jwks.json"
    },
    {
      "name": "internal",
      "header": "X-Internal-Token",
      "issuer": "https://internal.company.com",
      "audience": "ihub-internal",
      "jwkUrl": "https://internal.company.com/.well-known/jwks.json"
    }
  ]
}
```

## Group Mapping

Configure group mappings to translate JWT groups to application roles in `contents/config/groups.json`. External group mappings are handled via the "mappings" arrays within each group definition:

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
      "mappings": ["jwt-admins", "platform-admin"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user access",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["jwt-users"]
    },
    "developers": {
      "id": "developers",
      "name": "Developers",
      "description": "Developer access with additional tools",
      "permissions": {
        "apps": ["chat", "code-assistant", "api-tools"],
        "prompts": ["general", "development"],
        "models": ["gpt-4", "claude-3-sonnet"],
        "adminAccess": false
      },
      "mappings": ["jwt-developers"]
    }
  }
}
```

## Security Features

### Token Validation

- **Signature verification** using provider's public keys
- **Issuer validation** against configured issuer
- **Audience validation** against configured audience
- **Expiration checking** (`exp` claim)
- **Not-before checking** (`nbf` claim, if present)

### Security Best Practices

1. **Use HTTPS only** for token transmission
2. **Set appropriate token expiration** (recommended: 1-24 hours)
3. **Rotate signing keys regularly**
4. **Use RS256 algorithm** (not HS256 for production)
5. **Validate audience claims** to prevent token reuse
6. **Monitor failed authentication attempts**

## Troubleshooting

### Common Issues

#### 1. Token Validation Fails

**Error**: `JWT verification failed`

**Solutions**:

- Verify JWKs endpoint is accessible
- Check issuer and audience claims match configuration
- Ensure token is not expired
- Verify RS256 algorithm is used

#### 2. JWKs Fetch Error

**Error**: `Failed to load JWKs: 404`

**Solutions**:

- Verify JWKs URL is correct and accessible
- Check network connectivity from iHub server
- Ensure JWKs endpoint returns valid JSON

#### 3. User Not Found

**Error**: Token validates but user has no permissions

**Solutions**:

- Check user identity claims (`sub`, `email`, `preferred_username`)
- Verify group mappings are configured correctly
- Check if user has required groups in JWT

### Debug Mode

Enable debug logging by setting environment variable:

```bash
DEBUG=jwt:* npm start
```

### Token Inspection

Use online JWT debuggers (for development only):

- [jwt.io](https://jwt.io)
- [jwt-cli](https://github.com/mike-engel/jwt-cli)

### Manual Testing

Test JWT validation manually:

```bash
# Test JWKs endpoint
curl https://your-provider.com/.well-known/jwks.json

# Test API with token
curl -v -H "Authorization: Bearer YOUR_TOKEN" \
     https://your-ihub.com/api/auth/status
```

## Limitations

### Current Limitations

- **RS256 only**: No support for HMAC algorithms (HS256)
- **JWKs required**: Cannot use shared secrets
- **No token refresh**: Tokens must be refreshed externally
- **No custom claim mapping**: Fixed claim precedence order

### Potential Enhancements

If you need additional features, consider:

- HMAC algorithm support for simpler scenarios
- Custom claim mapping configuration
- Token refresh endpoint implementation
- Support for multiple audiences

## Comparison with Other Auth Methods

| Feature                    | JWT      | OIDC     | Local    | Proxy    |
| -------------------------- | -------- | -------- | -------- | -------- |
| External Identity Provider | ✅       | ✅       | ❌       | ✅       |
| No Auth Handshake          | ✅       | ❌       | ❌       | ✅       |
| Token Refresh              | ❌       | ✅       | ✅       | ❌       |
| User Management            | External | External | Internal | External |
| Setup Complexity           | Low      | Medium   | Low      | Low      |

## Related Documentation

- [External Authentication](external-authentication.md) - Overview of all auth methods
- [OIDC Authentication](oidc-authentication.md) - Full OIDC flow implementation
- [Platform Configuration](platform.md) - Complete platform config reference
- [Server Configuration](server-config.md) - Environment variable setup
