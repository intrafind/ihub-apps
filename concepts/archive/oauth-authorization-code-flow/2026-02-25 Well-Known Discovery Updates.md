# Well-Known Discovery Updates

**Date:** 2026-02-25
**Task:** Task 7 — Update `/.well-known/openid-configuration` to reflect OAuth Authorization Code Flow

---

## What was changed

File: `server/routes/wellKnown.js`

The `/.well-known/openid-configuration` GET handler (around line 99) was updated.

### Problems fixed

| # | Issue | Fix |
|---|-------|-----|
| 1 | `issuer` was the hardcoded string `'ihub-apps'` — OIDC spec (RFC 8414 §2) requires a URL | Now reads `platform.oauth.issuer` from config; falls back to the dynamic `baseUrl` derived from the request |
| 2 | `authorization_endpoint` pointed to `/api/auth/oidc` (the OIDC *login* route) | Changed to `/api/oauth/authorize` (the new Authorization Code Flow route) |
| 3 | `response_types_supported` included `'token'` (implicit flow) — not OIDC-correct | Reduced to `['code']` only |
| 4 | Missing `userinfo_endpoint`, `revocation_endpoint`, `end_session_endpoint` | Added all three |
| 5 | Missing `code_challenge_methods_supported` | Added `['S256']` |
| 6 | `grant_types_supported` was missing `'refresh_token'` | Added it |
| 7 | `scopes_supported` was missing `'offline_access'` | Added it |
| 8 | No `claims_supported` field | Added the full list of claims the server can return |
| 9 | No `request_parameter_supported` / `request_uri_parameter_supported` | Added both as `false` (honest declaration of unsupported features) |

---

## Resulting discovery document shape

```json
{
  "issuer": "<baseUrl or platform.oauth.issuer>",
  "jwks_uri": "<baseUrl>/.well-known/jwks.json",
  "authorization_endpoint": "<baseUrl>/api/oauth/authorize",
  "token_endpoint": "<baseUrl>/api/oauth/token",
  "userinfo_endpoint": "<baseUrl>/api/oauth/userinfo",
  "revocation_endpoint": "<baseUrl>/api/oauth/revoke",
  "end_session_endpoint": "<baseUrl>/api/oauth/logout",
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
  "grant_types_supported": ["client_credentials", "authorization_code", "refresh_token"],
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["sub", "name", "email", "groups", "iss", "aud", "exp", "iat", "nonce"],
  "request_parameter_supported": false,
  "request_uri_parameter_supported": false
}
```

---

## Issuer resolution logic

```js
const oauthConfig = platform.oauth || {};
const issuer =
  oauthConfig.issuer && oauthConfig.issuer.startsWith('http')
    ? oauthConfig.issuer
    : baseUrl;
```

- If `platform.oauth.issuer` is set and is a valid URL (starts with `http`), it is used verbatim.
- Otherwise the server derives a URL from the incoming request (`protocol + host + basePath`).

**Why this matters for junior developers:** The OIDC issuer value is embedded in every JWT the server
issues. If a client validates a JWT, it compares the `iss` claim against this discovery document.
Both must match exactly, including trailing slashes. If `platform.oauth.issuer` is set in
`contents/config/platform.json`, it must be the exact same string that is put in the `iss` claim
of access tokens and id tokens. See `server/utils/tokenService.js` for where JWTs are signed.

---

## How to verify (manual)

With the server running locally (`npm run dev`), fetch:

```
GET http://localhost:3000/.well-known/openid-configuration
```

Expected response: JSON object containing the fields listed above.
Check especially that `authorization_endpoint` ends in `/api/oauth/authorize` and `issuer` is a URL.

---

## Affected files

| File | Change type |
|------|-------------|
| `server/routes/wellKnown.js` | Modified — discovery object construction updated |

No migration needed (pure code change, no config schema change).
