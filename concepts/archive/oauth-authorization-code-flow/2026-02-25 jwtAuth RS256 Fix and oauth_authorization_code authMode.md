# jwtAuth.js RS256 Fix + oauth_authorization_code authMode

**Date:** 2026-02-25
**File changed:** `server/middleware/jwtAuth.js`
**Status:** Complete

---

## Problem summary

`jwtAuth.js` was calling `resolveJwtSecret()` to obtain the verification key for ALL
tokens. `resolveJwtSecret()` returns a symmetric (HS256) secret string. However, tokens
issued by `tokenService.generateJwt()` may be signed with RS256 (using an RSA private
key). Passing an HS256 secret to `jwt.verify()` when the token was signed with RS256
causes the verification to throw, and – more critically – using it to verify without
specifying the `algorithms` option left the door open for the classic algorithm-confusion
attack (an attacker can forge an RS256 public-key-signed token by re-signing it with
HS256 using the public key as the HMAC secret).

Additionally, the `oauth_authorization_code` `authMode` was not handled in the
else-if chain, so user-delegated tokens issued by the authorization code flow would
fall through to the generic "unknown authMode" branch and would not have their user
account status validated.

---

## Changes made

### 1. Import fix (line 4)

**Before:**
```js
import { resolveJwtSecret } from '../utils/tokenService.js';
```

**After:**
```js
import { getJwtVerificationKey, getJwtAlgorithm } from '../utils/tokenService.js';
```

`resolveJwtSecret` was removed from the import because it is no longer called anywhere
in this file. `tokenService.js` already exports `getJwtVerificationKey()` (returns the
RSA public key when RS256 is configured, or the HS256 secret otherwise) and
`getJwtAlgorithm()` (returns `'RS256'` or `'HS256'`).

### 2. Verification key lookup (formerly lines 37-42)

**Before:**
```js
const jwtSecret = resolveJwtSecret();
if (!jwtSecret) {
  logger.warn('JWT Auth: No JWT secret configured');
  return next();
}
```

**After:**
```js
const jwtVerificationKey = getJwtVerificationKey();
if (!jwtVerificationKey) {
  logger.warn('JWT Auth: No JWT verification key configured');
  return next();
}
```

### 3. jwt.verify call (formerly lines 47-50)

**Before:**
```js
const decoded = jwt.verify(token, jwtSecret, {
  issuer: 'ihub-apps',
  maxAge: '7d'
});
```

**After:**
```js
const decoded = jwt.verify(token, jwtVerificationKey, {
  issuer: 'ihub-apps',
  algorithms: [getJwtAlgorithm()],
  maxAge: '7d'
});
```

The `algorithms` option is mandatory to prevent algorithm-confusion attacks. The
`jsonwebtoken` library will now refuse to accept a token unless its `alg` header
matches exactly the value returned by `getJwtAlgorithm()`.

### 4. New else-if case: oauth_authorization_code (inserted between oauth_client_credentials and local)

Added a dedicated validation branch for tokens where `decoded.authMode === 'oauth_authorization_code'`.
These are user-delegated tokens (a real human authorised a third-party client via the
authorization code flow). Key differences from machine-to-machine tokens:

- Identity is taken from the token claims (`sub` / `username` / `id`), not from
  the OAuth client registry.
- The user record in `users.json` is checked for liveness / active status.
- If the user record does not exist the token is still accepted (the user may not yet
  be persisted in the local users file – same lenient behaviour as OIDC tokens).
- If the user record exists but is inactive, the token is rejected with 403.
- `req.user` is populated with `isOAuthAuthCode: true` and `clientId` so downstream
  middleware / routes can distinguish these tokens from machine tokens.

```js
} else if (decoded.authMode === 'oauth_authorization_code') {
  const oauthConfig = platform.oauth || {};
  if (oauthConfig.enabled) {
    try {
      const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
      const usersConfig = loadUsers(usersFilePath);
      const userId = decoded.sub || decoded.username || decoded.id;
      const userRecord = usersConfig.users?.[userId];

      if (userRecord && !isUserActive(userRecord)) {
        // 403 – user exists but is disabled
      }

      user = {
        id: userId,
        username: ...,
        authMode: 'oauth_authorization_code',
        isOAuthAuthCode: true,
        clientId: decoded.client_id || null,
        scopes: decoded.scopes || []
      };
    } catch (loadError) {
      // 503 – cannot read users file
    }
  } else {
    // 401 – OAuth not enabled
  }
}
```

---

## How to verify

1. **Lint passes:**
   ```bash
   npx eslint server/middleware/jwtAuth.js
   ```
   Expected: no output (no errors).

2. **Server starts:**
   ```bash
   timeout 10s node server/server.js 2>&1 | head -5
   ```
   Expected: normal startup log lines, no import/syntax errors.

3. **RS256 token is accepted** – generate a token via `tokenService.generateJwt()` when
   `JWT_ALGORITHM=RS256` is set, send it as `Authorization: Bearer <token>`, expect 200.

4. **HS256 token is rejected when RS256 is configured** – same token signed with HS256
   should now produce a 401 (algorithm mismatch).

5. **oauth_authorization_code token** – issue a token with `authMode: 'oauth_authorization_code'`
   via the auth code flow and confirm `req.user.isOAuthAuthCode === true`.

---

## Relevant files

| File | Role |
|---|---|
| `server/middleware/jwtAuth.js` | **Changed** – all four fixes above |
| `server/utils/tokenService.js` | Source of `getJwtVerificationKey()` and `getJwtAlgorithm()` |
| `server/utils/userManager.js` | `loadUsers()` and `isUserActive()` already imported |
| `server/utils/oauthClientManager.js` | Used by the existing oauth_client_credentials branch |
