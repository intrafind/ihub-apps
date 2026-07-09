# Authorization Code Store and PKCE Utils

**Date:** 2026-02-25
**Feature:** OAuth Authorization Code Flow
**Status:** Implemented and tested

---

## What Was Built

Two utility modules that form the foundation of the server-side OAuth Authorization Code flow:

| File | Purpose |
|------|---------|
| `server/utils/authorizationCodeStore.js` | In-memory store for short-lived, single-use authorization codes |
| `server/utils/pkceUtils.js` | PKCE (Proof Key for Code Exchange) challenge verification and generation |

---

## File 1: `authorizationCodeStore.js`

### Purpose

When a user approves an OAuth authorization request the server issues a short authorization code to the client. The client must exchange this code for tokens within a very short window. This module stores the mapping between the opaque code and the authorization context (client ID, user, scopes, PKCE challenge, etc.).

### Key Design Decisions

**Single-use codes.** Consuming a code deletes it immediately. If the same code arrives a second time (replay attack) the store logs a warning and returns `null`.

**10-minute TTL.** RFC 6749 recommends a very short lifetime. The store records `expiresAt` at write time and checks it at read time.

**In-memory only.** There is no database persistence. Authorization codes do not need to survive a server restart; any code issued before a restart simply becomes invalid, which is safe.

**Background cleanup.** A `setInterval` timer runs every 5 minutes to remove expired entries so memory does not grow unboundedly. The interval is `unref()`-ed so it does not keep the Node.js process alive during tests.

### Public API

```js
import {
  generateCode,   // () => string  — 64-char random hex code
  storeCode,      // (code, data) => void
  consumeCode,    // (code) => Object | null
  cleanup         // () => void  — also exported for tests
} from './authorizationCodeStore.js';
```

#### `storeCode(code, data)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | `string` | The authorization code to store |
| `data.clientId` | `string` | OAuth client that made the request |
| `data.redirectUri` | `string` | Redirect URI from the authorization request |
| `data.userId` | `string` | Authenticated user's identifier |
| `data.scopes` | `string[]` | Granted scopes |
| `data.codeChallenge` | `string?` | PKCE challenge (S256) |
| `data.codeChallengeMethod` | `string?` | Must be `'S256'` if present |
| `data.nonce` | `string?` | Nonce for OIDC ID token binding |

#### `consumeCode(code)`

Returns the stored `data` object on success, or `null` if the code is unknown, expired, or has already been used.

#### `generateCode()`

Returns `crypto.randomBytes(32).toString('hex')` — 64 hex characters / 256 bits of entropy.

### Usage Example (inside the authorize endpoint)

```js
import { generateCode, storeCode } from '../utils/authorizationCodeStore.js';

// After user approves consent:
const code = generateCode();
storeCode(code, {
  clientId: req.query.client_id,
  redirectUri: req.query.redirect_uri,
  userId: req.user.id,
  scopes: grantedScopes,
  codeChallenge: req.query.code_challenge,
  codeChallengeMethod: req.query.code_challenge_method,
  nonce: req.query.nonce
});

// Redirect back to client with the code
res.redirect(`${redirectUri}?code=${code}&state=${state}`);
```

### Usage Example (inside the token endpoint)

```js
import { consumeCode } from '../utils/authorizationCodeStore.js';

const codeData = consumeCode(req.body.code);
if (!codeData) {
  return res.status(400).json({ error: 'invalid_grant' });
}
// codeData is now available to issue tokens
```

---

## File 2: `pkceUtils.js`

### Purpose

PKCE (RFC 7636) prevents authorization code interception attacks by binding the code to a secret that only the legitimate client knows. This module provides the server-side verification logic plus helper functions for generating test fixtures.

### Key Design Decisions

**S256 only.** The `plain` method provides no real security (it is equivalent to sending the secret in the authorization request) and is therefore not implemented. Any request arriving with `code_challenge_method=plain` is rejected.

**Timing-safe comparison.** `crypto.timingSafeEqual` is used to compare the computed hash against the stored challenge, preventing timing side-channel attacks.

### Public API

```js
import {
  verifyCodeChallenge,  // (verifier, challenge, method) => boolean
  generateCodeChallenge, // (verifier) => string
  generateCodeVerifier   // () => string
} from './pkceUtils.js';
```

#### `verifyCodeChallenge(codeVerifier, codeChallenge, codeChallengeMethod)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `codeVerifier` | `string` | The plain-text verifier from the token request |
| `codeChallenge` | `string` | The BASE64URL challenge stored during authorization |
| `codeChallengeMethod` | `string` | Must be `'S256'`; anything else returns `false` |

Returns `true` when `BASE64URL(SHA256(codeVerifier)) === codeChallenge`.

#### `generateCodeChallenge(codeVerifier)`

Computes `BASE64URL(SHA256(codeVerifier))`. Use this in tests or in a future client-side helper.

#### `generateCodeVerifier()`

Returns `crypto.randomBytes(32).toString('base64url')` — 43 URL-safe characters.

### Usage Example (inside the token endpoint)

```js
import { verifyCodeChallenge } from '../utils/pkceUtils.js';

// codeData was retrieved by consumeCode() earlier
if (codeData.codeChallenge) {
  const valid = verifyCodeChallenge(
    req.body.code_verifier,
    codeData.codeChallenge,
    codeData.codeChallengeMethod
  );
  if (!valid) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }
}
```

---

## Test Results

All tests passed at implementation time:

```
# pkceUtils.js
PKCE test:          PASS   (valid verifier matches stored challenge)
Wrong verifier:     PASS   (incorrect verifier returns false)
Wrong method:       PASS   (plain method returns false)
Missing verifier:   PASS   (null verifier returns false)
Missing challenge:  PASS   (null challenge returns false)

# authorizationCodeStore.js
Store+consume:      PASS   (stored data is returned correctly)
Single-use replay:  PASS   (second consume returns null)
Unknown code:       PASS   (non-existent code returns null)
Code format:        PASS   (generateCode() returns 64-char hex)
```

---

## How These Modules Fit the Bigger Picture

```
Browser / Client
    │
    │  GET /oauth/authorize?code_challenge=...&code_challenge_method=S256
    ▼
Authorize Endpoint (to be implemented – Task 5)
    │  storeCode(generatedCode, { ..., codeChallenge, codeChallengeMethod })
    ▼
authorizationCodeStore.js  ◄── stores code + challenge
    │
    │  Redirect → client with code
    ▼
Token Endpoint (to be implemented – Task 6)
    │  consumeCode(code)  →  codeData (includes codeChallenge)
    │  verifyCodeChallenge(verifier, codeData.codeChallenge, 'S256')
    ▼
pkceUtils.js  ◄── verifies challenge
    │
    │  Issue access token + id token
    ▼
Client receives tokens
```

---

## Next Steps for the Junior Developer

1. **Task 5 (Authorize endpoint):** Create `server/routes/oauth/authorize.js`. It should:
   - Validate `client_id`, `redirect_uri`, `response_type=code`, `scope`
   - Require `code_challenge` + `code_challenge_method=S256` (enforce PKCE)
   - Show a consent screen (or auto-approve for trusted clients)
   - Call `storeCode()` and redirect to the client with the code

2. **Task 6 (Token endpoint):** Create/extend `server/routes/oauth/token.js`. For the `authorization_code` grant it should:
   - Call `consumeCode()` to retrieve stored data
   - Call `verifyCodeChallenge()` to validate PKCE
   - Issue access token + refresh token + (if `openid` scope) ID token

3. **Task 9 (Consent store):** Consider whether to build a persistent consent store so users are not shown the consent screen on every login for the same client+scope combination.

---

## Files Changed in This Task

- **Created:** `server/utils/authorizationCodeStore.js`
- **Created:** `server/utils/pkceUtils.js`
- **No config changes** — pure utility code, no migrations needed.
