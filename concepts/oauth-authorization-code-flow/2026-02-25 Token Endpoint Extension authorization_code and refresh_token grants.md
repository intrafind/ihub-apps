# Token Endpoint Extension: authorization_code + refresh_token Grants

**Date:** 2026-02-25
**Task:** 6 – Token Endpoint Extension
**Status:** Completed

---

## Overview

This document explains what was built, why, and how to continue the work if needed.

The `POST /api/oauth/token` endpoint previously only handled the `client_credentials` grant. This task extends it to handle the full Authorization Code Flow by adding:

1. `authorization_code` grant – exchanges a short-lived code for access + id + refresh tokens.
2. `refresh_token` grant – rotates a refresh token into a new access + refresh token pair.
3. `POST /api/oauth/revoke` – RFC 7009 revocation endpoint.
4. `GET /api/oauth/userinfo` – OIDC UserInfo endpoint.

---

## Files Changed or Created

| File | What changed |
|------|--------------|
| `server/utils/refreshTokenStore.js` | **New file.** File-backed refresh token store with SHA-256 indexing and bcrypt verification. |
| `server/routes/oauth.js` | Extended with new grant handlers and two new endpoints. |

---

## refreshTokenStore.js – Design Decisions

### Why file-backed and not in-memory?

Authorization codes (`authorizationCodeStore.js`) are intentionally in-memory: they are valid for only 10 minutes, and a server restart effectively invalidates all pending logins (no harm done, users retry). Refresh tokens are different – they have a 30-day TTL and represent a long-running session. Losing them on a server restart would log out every user who has an active session.

### Why SHA-256 as the map key?

The store is a JSON file. If we used the plaintext token as the key, anyone who can read the file could extract all active tokens. Using `SHA-256(token)` as the key means the file contains no usable token values – only hashes.

### Why bcrypt on top of SHA-256?

Defense in depth. SHA-256 alone is fast, so an attacker with the file could brute-force 64-hex-char tokens given enough GPU time (this is extremely hard in practice but still a risk). bcrypt adds a work factor that makes brute-force computationally infeasible even for short tokens.

### Token rotation

Each refresh token is single-use. `consumeRefreshToken()` deletes the entry immediately after a successful verification. The caller (the token endpoint) issues and stores a brand new token in the same response. If the client never receives the new token (network failure), they must re-authenticate. This is the standard RFC 6749 recommendation.

### Lazy expiry cleanup

Expired entries are pruned synchronously inside `storeRefreshToken()`. This keeps file size bounded without requiring a background timer (which would complicate testing and shutdown).

---

## oauth.js – Grant Flow Walkthrough

### authorization_code grant

```
POST /api/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "<code from /api/oauth/authorize>",
  "redirect_uri": "https://app.example.com/callback",
  "client_id": "client_myapp_abc12345",        // required for public clients
  "code_verifier": "<PKCE verifier>"           // required if code_challenge was stored
}
```

Processing order:

1. Sanitize and validate `code`, `redirect_uri`, `code_verifier`.
2. Call `consumeCode(code)` – returns stored data or null (single-use, replay-safe).
3. Load client from `oauth-clients.json` using `client_id` (falls back to `codeData.clientId` if not provided in request body).
4. If client is **confidential** (`clientType !== 'public'`), verify `client_secret` via `validateClientCredentials()`.
5. Assert `codeData.clientId === effectiveClientId` (prevents client substitution attacks).
6. Assert `codeData.redirectUri === redirect_uri` (prevents open-redirect token theft).
7. If `codeData.codeChallenge` is set, call `verifyCodeChallenge()`. If the client is `public` and no challenge was stored, reject (public clients must use PKCE).
8. Call `generateJwt()` with `authMode: 'oauth_authorization_code'` to produce the access token (RS256 by default).
9. Call `generateJwt()` again for the OIDC id_token, adding `at_hash` (left 22 chars of base64url SHA-256 of the access token per OIDC Core 3.3.2.11).
10. If `client.grantTypes` includes `'refresh_token'`, generate and store a refresh token.

Response fields:
- `access_token` – RS256 JWT, carries `sub`, `name`, `email`, `groups`, `client_id`, `scopes`, `authMode`.
- `id_token` – RS256 JWT, carries all above plus `at_hash` and `nonce`.
- `token_type` – always `"Bearer"`.
- `expires_in` – seconds until access token expires.
- `scope` – space-separated list of granted scopes.
- `refresh_token` – only present if client supports it.

### refresh_token grant

```
POST /api/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "<64-char hex token>"
}
```

Processing order:

1. Sanitize `refresh_token`.
2. Call `consumeRefreshToken(token)` – atomically verifies + deletes the entry (rotation).
3. Load client from store and confirm it is still active.
4. Call `generateJwt()` with the same `authMode: 'oauth_authorization_code'` and the stored user context.
5. Call `generateRefreshToken()` + `storeRefreshToken()` for the new token.
6. Return `access_token`, `token_type`, `expires_in`, `scope`, `refresh_token`.

### client_credentials grant (unchanged)

Falls through to the original `generateOAuthToken()` call which uses HS256 and is scoped to machine-to-machine use cases.

---

## Revoke Endpoint

```
POST /api/oauth/revoke
Content-Type: application/json

{ "token": "<refresh token>" }
```

Calls `revokeRefreshToken()`. Per RFC 7009 §2.2 the server returns HTTP 200 regardless of whether the token was present, to avoid confirming token existence to an attacker.

---

## UserInfo Endpoint

```
GET /api/oauth/userinfo
Authorization: Bearer <access token from authorization_code flow>
```

Calls `verifyJwt()` and checks `decoded.authMode === 'oauth_authorization_code'`. Client credentials tokens are rejected with `403 insufficient_scope` because they represent a machine identity, not a user.

Returns: `sub`, `name`, `email`, `groups`.

---

## Key Security Properties

| Property | How it is enforced |
|----------|--------------------|
| Code is single-use | `consumeCode()` deletes the entry on first use; replay returns null |
| Refresh token is single-use | `consumeRefreshToken()` deletes before returning data |
| PKCE required for public clients | Enforced in `authorization_code` branch |
| Confidential clients authenticate | `validateClientCredentials()` called when `clientType !== 'public'` |
| redirect_uri binding | Strict string equality check against `codeData.redirectUri` |
| Tokens signed RS256 | `generateJwt()` from `tokenService.js` uses RS256 by default |
| Refresh tokens bcrypt-hashed | bcrypt work factor 10 in `storeRefreshToken()` |
| Revocation leaks nothing | HTTP 200 always, per RFC 7009 |

---

## Configuration Reference

The following `platform.json` keys affect this feature:

```json
{
  "oauth": {
    "enabled": true,
    "clientsFile": "contents/config/oauth-clients.json",
    "refreshTokenExpirationDays": 30
  }
}
```

The `refreshTokenExpirationDays` key is read at token-issue time. Changing it only affects newly issued tokens – existing tokens retain their original `expiresAt`.

Client-level TTL is controlled by `tokenExpirationMinutes` in the client record. Clients that should issue refresh tokens must list `"refresh_token"` in their `grantTypes` array.

---

## Where to Continue

- Task 7: Update `/.well-known/openid-configuration` to advertise the new grant types and endpoints.
- Task 8: Security hardening (rate limiting on `/token`, DPoP, client authentication improvements).
- Task 9: Consent store (persist user consent decisions so repeat logins skip the consent screen).
- Task 12: E2E tests covering the full authorization_code + PKCE flow, token rotation, revocation.
