# JWT Well-Known Endpoints

iHub Apps exposes standard well-known endpoints for JWT validation and OpenID Connect discovery. These endpoints allow external applications to discover JWT configuration and verify tokens issued by iHub Apps.

## Overview

The well-known endpoints provide:

- **OpenID Connect Discovery**: Metadata about JWT configuration and supported features
- **JWKS (JSON Web Key Set)**: Public keys for JWT signature verification

These endpoints are crucial for scenarios where external applications need to validate JWT tokens issued by iHub Apps without requiring direct access to the authentication system.

## Endpoints

### OpenID Connect Discovery

**Endpoint**: `/.well-known/openid-configuration`

Returns OpenID Connect Discovery metadata including:

- Issuer identifier
- JWKS endpoint URL
- Authorization and token endpoints
- Supported algorithms and grant types
- Supported scopes

**Example Request**:
```bash
curl https://your-ihub-domain.com/.well-known/openid-configuration
```

**Example Response**:
```json
{
  "issuer": "ihub-apps",
  "jwks_uri": "https://your-ihub-domain.com/.well-known/jwks.json",
  "authorization_endpoint": "https://your-ihub-domain.com/api/auth/oidc",
  "token_endpoint": "https://your-ihub-domain.com/api/oauth/token",
  "response_types_supported": ["token", "code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["HS256"],
  "token_endpoint_auth_methods_supported": [
    "client_secret_post",
    "client_secret_basic"
  ],
  "grant_types_supported": [
    "client_credentials",
    "authorization_code"
  ],
  "scopes_supported": ["openid", "profile", "email"]
}
```

### JWKS (JSON Web Key Set)

**Endpoint**: `/.well-known/jwks.json`

Returns public keys for JWT signature verification.

**For HS256 (Symmetric Algorithm)**:
```json
{
  "keys": [],
  "note": "JWKS not available for HS256 (symmetric) algorithm. Public key sharing requires RS256 (asymmetric) algorithm. Configure \"jwt.algorithm\": \"RS256\" in platform.json to enable public key sharing."
}
```

**For RS256 (Asymmetric Algorithm)**:
```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "w_7VjVZ3eoM8...",
      "e": "AQAB",
      "use": "sig",
      "kid": "e67f5e39d283ddec",
      "alg": "RS256"
    }
  ]
}
```

**Example Request**:
```bash
curl https://your-ihub-domain.com/.well-known/jwks.json
```

## Configuration

### JWT Signing Algorithm

iHub Apps uses **RS256** (RSA with SHA-256) as the default JWT signing algorithm. This allows public key sharing via the JWKS endpoint, enabling external applications to validate JWT tokens.

Configure the JWT signing algorithm in `contents/config/platform.json`:

```json
{
  "jwt": {
    "algorithm": "RS256"
  }
}
```

**Supported Algorithms**:

- **RS256** (default): RSA with SHA-256 (asymmetric)
  - Public key can be shared for verification
  - Required for external token validation
  - Enables JWKS endpoint
  - Suitable for federated authentication and external integrations

- **HS256**: HMAC with SHA-256 (symmetric)
  - Faster performance
  - Lower computational overhead
  - Secret key cannot be shared publicly
  - Suitable only for internal systems without external validation needs

### Switching to HS256 (Not Recommended)

If you need to use HS256 for legacy systems:

1. Update `contents/config/platform.json`:
   ```json
   {
     "jwt": {
       "algorithm": "HS256"
     }
   }
   ```

2. Restart the server

Note: JWKS endpoint will return empty keys with an informational message when using HS256.

### RSA Key Management

When using RS256 (default), the server will automatically:
- Generate a 2048-bit RSA key pair on first startup
- Store private key at `contents/.jwt-private-key.pem` (mode 600)
- Store public key at `contents/.jwt-public-key.pem` (mode 644)
- Expose public key via `/.well-known/jwks.json`

### Environment Variables

You can also provide RSA keys via environment variables:

```bash
export JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----"

export JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD...
-----END PRIVATE KEY-----"
```

## Use Cases

### External Application Validates iHub Apps JWT

External applications can validate JWT tokens issued by iHub Apps:

1. **Discover Configuration**:
   ```bash
   curl https://ihub-apps.example.com/.well-known/openid-configuration
   ```

2. **Fetch Public Keys**:
   ```bash
   curl https://ihub-apps.example.com/.well-known/jwks.json
   ```

3. **Verify JWT Token**:
   ```javascript
   const jwksClient = require('jwks-rsa');
   const jwt = require('jsonwebtoken');

   const client = jwksClient({
     jwksUri: 'https://ihub-apps.example.com/.well-known/jwks.json'
   });

   function getKey(header, callback) {
     client.getSigningKey(header.kid, (err, key) => {
       const signingKey = key.publicKey || key.rsaPublicKey;
       callback(null, signingKey);
     });
   }

   jwt.verify(token, getKey, {
     issuer: 'ihub-apps',
     audience: 'ihub-apps',
     algorithms: ['RS256']
   }, (err, decoded) => {
     if (err) {
       console.error('Token validation failed:', err);
     } else {
       console.log('Token validated:', decoded);
     }
   });
   ```

### Spring Boot Integration

Configure Spring Security to validate iHub Apps JWT tokens:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://ihub-apps.example.com
          jwk-set-uri: https://ihub-apps.example.com/.well-known/jwks.json
```

### ASP.NET Core Integration

Configure JWT authentication in ASP.NET Core:

```csharp
services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://ihub-apps.example.com";
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "ihub-apps",
            ValidateAudience = true,
            ValidAudience = "ihub-apps",
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });
```

## Security Considerations

### Key Management

1. **Backup Keys**: Keep secure backups of RSA key files
   - `contents/.jwt-private-key.pem` (private key - critical)
   - `contents/.jwt-public-key.pem` (public key)

2. **Key Rotation**: Consider rotating keys periodically:
   - Delete existing key files
   - Restart server to generate new keys
   - Update external applications with new public key

3. **File Permissions**: Ensure correct permissions:
   ```bash
   chmod 600 contents/.jwt-private-key.pem
   chmod 644 contents/.jwt-public-key.pem
   ```

4. **Environment-Specific Keys**: Use different keys for development, staging, and production

### Algorithm Selection

**RS256 is the default and recommended algorithm** for all deployments as it enables:
- External token validation via JWKS
- Federated authentication scenarios
- Multi-application environments
- Public API integrations

**Use HS256 only** for legacy systems that:
- Require symmetric key signing for compatibility
- Have no external token validation requirements
- Are internal-only with no federated authentication needs

## Troubleshooting

### JWKS Returns Empty Keys Array

**Symptom**: JWKS endpoint returns empty keys array with note about HS256

**Cause**: JWT signing algorithm is set to HS256 (symmetric)

**Solution**: HS256 is not recommended for production. Switch to RS256 (default) in platform.json

### External Application Cannot Verify Tokens

**Symptom**: External application fails to verify JWT tokens

**Possible Causes**:

1. **Algorithm Mismatch**: Check `id_token_signing_alg_values_supported` in discovery endpoint
2. **Issuer/Audience Mismatch**: Verify token claims match expected values
3. **Clock Skew**: Ensure clocks are synchronized between systems
4. **Key ID Mismatch**: Verify `kid` in JWT header matches JWKS key

**Debug Steps**:

1. Check discovery endpoint configuration:
   ```bash
   curl https://ihub-apps.example.com/.well-known/openid-configuration | jq
   ```

2. Verify JWKS contains keys:
   ```bash
   curl https://ihub-apps.example.com/.well-known/jwks.json | jq
   ```

3. Decode JWT token (without verification):
   ```bash
   echo "YOUR_JWT_TOKEN" | cut -d. -f2 | base64 -d | jq
   ```

4. Check server logs for JWT signing errors

### RSA Key Generation Failed

**Symptom**: Server logs show RSA key generation errors

**Possible Causes**:

1. **Insufficient Permissions**: Server cannot write to contents directory
2. **Disk Space**: Insufficient disk space for key files
3. **OpenSSL Issues**: Missing or outdated crypto libraries

**Solution**:

1. Verify directory permissions:
   ```bash
   ls -ld contents/
   ```

2. Check disk space:
   ```bash
   df -h
   ```

3. Manually generate keys and provide via environment variables

## Related Documentation

- [JWT Authentication](jwt-authentication.md) - JWT authentication configuration
- [OAuth 2.0](oauth.md) - OAuth 2.0 client credentials
- [External Authentication](external-authentication.md) - External authentication methods
- [Platform Configuration](platform.md) - Platform configuration reference

## Support

For issues with JWT well-known endpoints:

1. **Check Configuration**: Review platform.json JWT settings
2. **Verify Keys**: Ensure RSA key files exist and have correct permissions
3. **Test Endpoints**: Verify discovery and JWKS endpoints return valid responses
4. **Check Logs**: Review server logs for JWT-related errors
5. **Contact Support**: Provide configuration details (redact sensitive information)

---

_Last updated: February 2026_
