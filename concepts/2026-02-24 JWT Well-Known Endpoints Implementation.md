# JWT Well-Known Endpoints Implementation Summary

## Overview

This implementation adds OpenID Connect Discovery and JWKS (JSON Web Key Set) endpoints to iHub Apps, enabling external applications to discover JWT configuration and verify tokens issued by the platform.

## What Was Implemented

### 1. Well-Known Endpoints

Two new endpoints were added to the server:

- **`/.well-known/openid-configuration`**: OpenID Connect Discovery endpoint
  - Returns metadata about JWT configuration
  - Includes issuer, JWKS URI, supported algorithms, grant types, and scopes

- **`/.well-known/jwks.json`**: JSON Web Key Set endpoint
  - Returns public keys for JWT signature verification (RS256 only)
  - For HS256, returns informational message about algorithm limitations

### 2. RSA Key Pair Support

Enhanced `TokenStorageService` to support RSA key pairs for RS256 signing:

- Automatic RSA key pair generation on first startup
- Persistent key storage in `contents/.jwt-private-key.pem` (mode 600) and `contents/.jwt-public-key.pem` (mode 644)
- Environment variable support for custom keys (`JWT_PUBLIC_KEY`, `JWT_PRIVATE_KEY`)
- Key pair initialization at server startup

### 3. Dual Algorithm Support

Updated `tokenService.js` to support both HS256 and RS256:

- **HS256 (default)**: HMAC with SHA-256 (symmetric, faster, secret cannot be shared)
- **RS256**: RSA with SHA-256 (asymmetric, public key can be shared for external validation)

New functions:
- `getJwtAlgorithm()` - Get configured algorithm from platform.json
- `getJwtSigningKey()` - Get appropriate signing key based on algorithm
- `getJwtVerificationKey()` - Get appropriate verification key based on algorithm

### 4. Configuration

Added JWT configuration to `platform.json`:

```json
{
  "jwt": {
    "algorithm": "HS256"  // or "RS256"
  }
}
```

### 5. Documentation

Created comprehensive documentation at `docs/jwt-well-known-endpoints.md`:

- Endpoint descriptions and examples
- Configuration instructions
- Use cases for external integrations
- Security considerations
- Troubleshooting guide

## Files Changed/Created

### New Files

- `server/routes/wellKnown.js` - Well-known endpoints implementation
- `docs/jwt-well-known-endpoints.md` - Complete documentation

### Modified Files

- `server/server.js` - Register well-known routes, initialize RSA keys
- `server/services/TokenStorageService.js` - Add RSA key pair management
- `server/utils/tokenService.js` - Add dual algorithm support
- `docs/SUMMARY.md` - Add new documentation link

## Testing

The implementation was tested with:

1. **OpenID Discovery endpoint** - Returns correct metadata for both HS256 and RS256
2. **JWKS endpoint** - Returns empty array with note for HS256, public key in JWK format for RS256
3. **Token generation and verification** - Successfully created and verified JWT tokens using RS256

## Use Cases

### External Token Validation

External applications can now:
1. Discover JWT configuration via `/.well-known/openid-configuration`
2. Fetch public keys via `/.well-known/jwks.json`
3. Verify JWT tokens issued by iHub Apps without direct access to the authentication system

### Integration Examples

The documentation includes examples for:
- Node.js (using `jwks-rsa`)
- Spring Boot (Spring Security OAuth2)
- ASP.NET Core (JWT Bearer authentication)

## Migration

No migration is required. The implementation:
- Defaults to HS256 (existing behavior)
- Automatically generates RSA keys when RS256 is configured
- Maintains backward compatibility with existing installations

To enable RS256:
1. Add `{"jwt": {"algorithm": "RS256"}}` to `platform.json`
2. Restart the server
3. RSA keys will be generated automatically

## Security Considerations

- Private keys stored with restrictive permissions (mode 600)
- Public keys world-readable (mode 644)
- Keys persist across server restarts
- Environment variable support for custom keys
- Secure key generation using Node.js crypto module (2048-bit RSA)

## Future Enhancements (Optional)

- Key rotation mechanism
- Multiple key support (key versioning)
- Custom issuer and audience configuration
- Integration tests with external JWT validators
- Support for additional algorithms (ES256, PS256)

## Related Documentation

- [JWT Authentication](docs/jwt-authentication.md)
- [JWT Well-Known Endpoints](docs/jwt-well-known-endpoints.md)
- [External Authentication](docs/external-authentication.md)
- [OAuth 2.0](docs/oauth.md)

## Testing Instructions

To test the implementation:

```bash
# Start the server
npm run dev

# Test OpenID Discovery
curl http://localhost:3000/.well-known/openid-configuration | jq

# Test JWKS (with HS256 - default)
curl http://localhost:3000/.well-known/jwks.json | jq

# Switch to RS256
# Edit contents/config/platform.json and add:
# {"jwt": {"algorithm": "RS256"}}

# Restart server

# Test JWKS (with RS256)
curl http://localhost:3000/.well-known/jwks.json | jq

# Verify public key is present
ls -la contents/.jwt-*.pem
```

---

**Implementation Date**: February 2026
**Implemented By**: GitHub Copilot
