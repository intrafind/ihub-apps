# JWT RS256/HS256 Authentication Bug Fix

**Date:** 2026-02-25  
**Issue:** Login fails when RS256 is configured but JWT_SECRET is set  
**Status:** Fixed

## Problem Statement

When RS256 (asymmetric) algorithm is configured for JWT signing in `platform.json`, user login fails despite RSA public/private keys being generated. The root cause was that JWT_SECRET environment variable or the auto-generated JWT secret was being used for token verification regardless of the configured algorithm.

## Root Cause Analysis

The authentication flow had a mismatch between token generation and verification:

### Token Generation (Correct)
All authentication middleware (`localAuth.js`, `oidcAuth.js`, `ldapAuth.js`, `ntlmAuth.js`, `teamsAuth.js`) correctly used the centralized `generateJwt()` function from `tokenService.js`, which:
1. Reads the configured algorithm from `platform.jwt.algorithm`
2. Uses RSA private key for RS256 or JWT secret for HS256
3. Signs tokens with the correct algorithm

### Token Verification (Incorrect)
Two files were bypassing the centralized verification and always using HS256:

1. **`server/middleware/jwtAuth.js`** (Primary Issue)
   - Directly called `resolveJwtSecret()` to get JWT secret
   - Used `jwt.verify(token, jwtSecret)` without specifying algorithm
   - Result: Tokens signed with RS256 failed verification with HS256 secret

2. **`server/utils/oauthTokenService.js`** (Secondary Issue)
   - Hardcoded `algorithm: 'HS256'` in token generation
   - Directly called `resolveJwtSecret()` for verification
   - Result: OAuth tokens always used HS256 regardless of configuration

### Impact

When `platform.json` had `jwt.algorithm: "RS256"`:
- ✅ Login generates token signed with RSA private key
- ❌ Subsequent requests fail because jwtAuth middleware tries to verify with HS256
- 🔴 Result: **Login appears to succeed but user is immediately logged out**

## Solution

### Changes Made

#### 1. Fixed `server/middleware/jwtAuth.js`

**Before:**
```javascript
import jwt from 'jsonwebtoken';
import { resolveJwtSecret } from '../utils/tokenService.js';

// Line 37-47
const jwtSecret = resolveJwtSecret();

if (!jwtSecret) {
  logger.warn('🔐 JWT Auth: No JWT secret configured');
  return next();
}

const decoded = jwt.verify(token, jwtSecret, {
  issuer: 'ihub-apps',
  maxAge: '7d'
});
```

**After:**
```javascript
import { verifyJwt } from '../utils/tokenService.js';

// Line 40-44
const decoded = verifyJwt(token);

if (!decoded) {
  logger.warn('🔐 JWT Auth: Token verification failed');
  return next(); // Invalid token, continue as anonymous
}
```

**Changes:**
- Replaced direct `jwt.verify()` call with centralized `verifyJwt()` function
- Removed unused `jwt` and `resolveJwtSecret` imports
- Added null check for failed verification
- Simplified code by removing duplicate checks

#### 2. Fixed `server/utils/oauthTokenService.js`

**Token Generation - Before:**
```javascript
import { resolveJwtSecret } from './tokenService.js';

const jwtSecret = resolveJwtSecret();

if (!jwtSecret) {
  throw new Error('JWT secret not configured for OAuth authentication');
}

const token = jwt.sign(tokenPayload, jwtSecret, {
  expiresIn: `${expiresIn}s`,
  issuer: 'ihub-apps',
  audience: 'ihub-apps',
  algorithm: 'HS256'  // ❌ Hardcoded
});
```

**Token Generation - After:**
```javascript
import { verifyJwt, getJwtAlgorithm, getJwtSigningKey } from './tokenService.js';

const algorithm = getJwtAlgorithm();
const signingKey = getJwtSigningKey();

if (!signingKey) {
  throw new Error(`JWT signing key not configured for OAuth authentication with ${algorithm}`);
}

const token = jwt.sign(tokenPayload, signingKey, {
  expiresIn: `${expiresIn}s`,
  issuer: 'ihub-apps',
  audience: 'ihub-apps',
  algorithm: algorithm  // ✅ Uses configured algorithm
});
```

**Token Verification - Before:**
```javascript
const jwtSecret = resolveJwtSecret();

if (!jwtSecret) {
  logger.warn('[OAuth] JWT secret not configured for token verification');
  return null;
}

const decoded = jwt.verify(token, jwtSecret, {
  issuer: 'ihub-apps',
  audience: 'ihub-apps'
});

if (decoded.authMode !== 'oauth_client_credentials') {
  return null;
}

return decoded;
```

**Token Verification - After:**
```javascript
const decoded = verifyJwt(token);

if (!decoded) {
  logger.warn('[OAuth] Token verification failed');
  return null;
}

if (decoded.authMode !== 'oauth_client_credentials') {
  return null;
}

return decoded;
```

**Changes:**
- Updated `generateOAuthToken()` to use `getJwtAlgorithm()` and `getJwtSigningKey()`
- Updated `generateStaticApiKey()` to use `getJwtAlgorithm()` and `getJwtSigningKey()`
- Updated `verifyOAuthToken()` to use centralized `verifyJwt()`
- Removed hardcoded `algorithm: 'HS256'` from both token generation functions
- Simplified error handling (centralized in `verifyJwt()`)

## Architecture

The fix leverages the existing centralized JWT functions in `tokenService.js`:

```
tokenService.js
├── getJwtAlgorithm()          → Reads platform.jwt.algorithm (RS256 or HS256)
├── getJwtSigningKey()         → Returns RSA private key (RS256) or JWT secret (HS256)
├── getJwtVerificationKey()    → Returns RSA public key (RS256) or JWT secret (HS256)
├── generateJwt()              → ✅ Already algorithm-aware (used by all auth middleware)
└── verifyJwt()                → ✅ Already algorithm-aware (now used by jwtAuth and OAuth)
```

### Authentication Flow (After Fix)

#### Login Flow
```
1. User logs in via localAuth/oidcAuth/ldapAuth/etc.
   ↓
2. Auth middleware calls generateJwt(user, { authMode: 'local' })
   ↓
3. generateJwt() calls getJwtAlgorithm() → 'RS256'
   ↓
4. generateJwt() calls getJwtSigningKey() → RSA private key
   ↓
5. jwt.sign(payload, rsaPrivateKey, { algorithm: 'RS256' })
   ↓
6. Token returned to client in cookie/header
```

#### Subsequent Requests
```
1. Client sends token in cookie or Authorization header
   ↓
2. jwtAuth.js middleware extracts token
   ↓
3. Calls verifyJwt(token)
   ↓
4. verifyJwt() calls getJwtAlgorithm() → 'RS256'
   ↓
5. verifyJwt() calls getJwtVerificationKey() → RSA public key
   ↓
6. jwt.verify(token, rsaPublicKey, { algorithms: ['RS256'] })
   ↓
7. Token verified ✅ → User authenticated
```

### Why This Works

The `verifyJwt()` function in `tokenService.js` (lines 157-176):
1. Calls `getJwtAlgorithm()` to determine RS256 or HS256
2. Calls `getJwtVerificationKey()` to get the appropriate key
3. Calls `jwt.verify(token, key, { algorithms: [algorithm] })` with correct algorithm
4. Returns decoded payload or null if verification fails

### Why It Failed Before

The old `jwtAuth.js` implementation:
1. Called `resolveJwtSecret()` directly (always returns HS256 secret)
2. Called `jwt.verify(token, jwtSecret)` without algorithm specification
3. jsonwebtoken library defaults to HS256 when no algorithm specified
4. Result: RS256 tokens fail verification with HS256 secret

## Testing

### Automated Testing

Created `server/tests/jwt-algorithm-verification.test.js` to verify:
- ✅ RS256 tokens can be signed and verified with RSA key pair
- ✅ HS256 tokens can be signed and verified with shared secret
- ✅ RS256 tokens are rejected when verifying with HS256
- ✅ HS256 tokens are rejected when verifying with RS256

Test output:
```
✅ Token signed with RS256 private key
✅ Token verified with RS256 public key
✅ RS256 token correctly rejected when verifying with HS256 secret

✅ Token signed with HS256 secret
✅ Token verified with HS256 secret
✅ HS256 token correctly rejected when using RS256 verification
```

### Integration Testing

- ✅ Server starts successfully
- ✅ All adapter tests pass (`npm run test:adapters`)
- ✅ No breaking changes to existing functionality

### Manual Testing Steps

To verify the fix works in a real environment:

1. **Configure RS256** in `contents/config/platform.json`:
   ```json
   {
     "jwt": {
       "algorithm": "RS256"
     }
   }
   ```

2. **Start the server** - RSA keys will be auto-generated on first startup
3. **Login** with a local account
4. **Verify login succeeds** and user stays authenticated
5. **Check JWKS endpoint** - should return public key at `/.well-known/jwks.json`

Expected behavior:
- Login succeeds ✅
- User remains authenticated on subsequent requests ✅
- JWKS endpoint returns public key ✅

## Configuration

The fix respects the JWT algorithm configuration in `platform.json`:

### RS256 (Default and Recommended)
```json
{
  "jwt": {
    "algorithm": "RS256"
  }
}
```

**Behavior:**
- Tokens signed with RSA private key (`contents/.jwt-private-key.pem`)
- Tokens verified with RSA public key (`contents/.jwt-public-key.pem`)
- Public key can be shared via `/.well-known/jwks.json`
- Suitable for federated authentication and external integrations

**Key Files:**
- `contents/.jwt-private-key.pem` - RSA private key (auto-generated, mode 0600)
- `contents/.jwt-public-key.pem` - RSA public key (auto-generated, mode 0644)

### HS256 (Legacy)
```json
{
  "jwt": {
    "algorithm": "HS256"
  }
}
```

**Behavior:**
- Tokens signed with JWT secret (from `JWT_SECRET` env var or auto-generated)
- Tokens verified with same JWT secret
- Secret cannot be shared publicly
- Suitable only for internal systems

**Key Files:**
- `contents/.jwt-secret` - Encrypted JWT secret (auto-generated)

## Affected Components

### Authentication Middleware (All Working Correctly)
- ✅ `localAuth.js` - Uses `generateJwt()` (already correct)
- ✅ `oidcAuth.js` - Uses `generateJwt()` (already correct)
- ✅ `ldapAuth.js` - Uses `generateJwt()` (already correct)
- ✅ `ntlmAuth.js` - Uses `generateJwt()` (already correct)
- ✅ `teamsAuth.js` - Uses `generateJwt()` for internal tokens (already correct)

### JWT Verification (Fixed)
- ✅ `jwtAuth.js` - Now uses `verifyJwt()` (FIXED)
- ✅ `oauthTokenService.js` - Now uses algorithm-aware functions (FIXED)

### External Token Verification (Not Affected)
- ✅ `proxyAuth.js` - Verifies external JWT from providers (uses provider's JWKS)
- ✅ `teamsAuth.js` - Verifies Microsoft Azure AD tokens (uses Microsoft's JWKS)
- ✅ `iFinderJwt.js` - Generates iFinder-specific tokens (separate system)

## Migration Impact

No migration required. The fix is backward compatible:
- Existing RS256 installations will now work correctly
- Existing HS256 installations continue to work
- No configuration changes needed
- Existing tokens remain valid (signed and verified with same algorithm)

## Security Considerations

This fix improves security by:
1. ✅ Enforcing the configured JWT algorithm
2. ✅ Preventing algorithm confusion attacks
3. ✅ Enabling proper RS256 usage for public key sharing
4. ✅ Maintaining algorithm consistency between signing and verification

## Related Documentation

- `docs/jwt-well-known-endpoints.md` - JWT configuration and well-known endpoints
- `concepts/2026-02-24 JWT Well-Known Endpoints Implementation.md` - Original RS256 implementation
- `server/migrations/V005__jwt_rs256_algorithm.js` - Migration that set RS256 as default

## Files Modified

1. **`server/middleware/jwtAuth.js`**
   - Changed: Use `verifyJwt()` instead of direct `jwt.verify()`
   - Impact: JWT verification now respects configured algorithm
   - Lines changed: 1, 4, 37-47

2. **`server/utils/oauthTokenService.js`**
   - Changed: Use algorithm-aware functions for token generation and verification
   - Impact: OAuth tokens now use configured algorithm instead of hardcoded HS256
   - Functions updated: `generateOAuthToken()`, `verifyOAuthToken()`, `generateStaticApiKey()`

3. **`server/tests/jwt-algorithm-verification.test.js`** (NEW)
   - Added: Test to verify both RS256 and HS256 work correctly
   - Impact: Prevents regression

## Verification Checklist

- [x] Server starts without errors
- [x] Adapter tests pass
- [x] JWT algorithm verification test passes
- [x] Code follows existing patterns
- [x] No breaking changes to API
- [x] No configuration changes required
- [x] Documentation is consistent with implementation

## Future Considerations

None. The fix is complete and requires no additional work.
