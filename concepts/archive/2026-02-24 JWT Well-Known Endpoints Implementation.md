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

### 3. Default Algorithm Changed to RS256

Updated default JWT algorithm from HS256 to RS256:

- **RS256 (now default)**: RSA with SHA-256 (asymmetric, public key can be shared for external validation)
- **HS256**: HMAC with SHA-256 (symmetric, faster, secret cannot be shared) - available for legacy use

New functions:
- `getJwtAlgorithm()` - Get configured algorithm from platform.json (defaults to RS256)
- `getJwtSigningKey()` - Get appropriate signing key based on algorithm
- `getJwtVerificationKey()` - Get appropriate verification key based on algorithm

### 4. Configuration

Added JWT configuration to `platform.json` with RS256 as default:

```json
{
  "jwt": {
    "algorithm": "RS256"  // Default (or "HS256" for legacy)
  }
}
```

### 5. Migration for Existing Installations

Created migration `V005__jwt_rs256_algorithm.js` to:
- Automatically switch existing installations to RS256
- Note: This invalidates existing JWT tokens (users need to login again)
- This is acceptable for improved security and external token validation

### 6. Documentation

Created comprehensive documentation at `docs/jwt-well-known-endpoints.md`:

- Endpoint descriptions and examples
- Configuration instructions
- Use cases for external integrations
- Security considerations
- Troubleshooting guide

## Files Changed/Created

### New Files

- `server/routes/wellKnown.js` - Well-known endpoints implementation
- `server/migrations/V005__jwt_rs256_algorithm.js` - Migration to switch existing installations to RS256
- `docs/jwt-well-known-endpoints.md` - Complete documentation
- `concepts/2026-02-24 JWT Well-Known Endpoints Implementation.md` - This summary

### Modified Files

- `server/server.js` - Register well-known routes, initialize RSA keys
- `server/services/TokenStorageService.js` - Add RSA key pair management
- `server/utils/tokenService.js` - Add dual algorithm support, change default to RS256
- `server/defaults/config/platform.json` - Add jwt.algorithm: "RS256" default
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

Migration `V005__jwt_rs256_algorithm.js` is included to automatically:
- Switch existing installations from HS256 to RS256
- Add JWT configuration to platform.json if missing
- Log that existing JWT tokens will be invalidated

**Impact**: Users will need to login again after the migration runs. This is acceptable as:
- It enables external token validation (the primary goal)
- Improves security with asymmetric key signing
- Allows public key sharing via JWKS endpoint

Fresh installations:
- Already default to RS256 via `server/defaults/config/platform.json`
- Skip the migration automatically

To revert to HS256 (not recommended):
1. Manually set `{"jwt": {"algorithm": "HS256"}}` in `platform.json`
2. Restart the server

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
