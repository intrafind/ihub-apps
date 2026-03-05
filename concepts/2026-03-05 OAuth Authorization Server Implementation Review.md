# OAuth Authorization Server - Implementation Review

**Date:** 2026-03-05

## Context

The goal was to make iHub Apps act as an OAuth 2.0 / OIDC Authorization Server so that external "resource server" applications can authenticate users and obtain tokens from iHub. This document reviews how far the implementation got, what is missing, and whether we can test it end-to-end using the example app.

---

## Current State: What Is Complete

The implementation is **very comprehensive** — nearly production-ready. Here's what exists:

### Server-Side (all registered in `server/server.js`)

| Component | File | Status |
|---|---|---|
| Token endpoint (`POST /api/oauth/token`) | `server/routes/oauth.js` | Done — supports `client_credentials`, `authorization_code`, `refresh_token` grants |
| Introspect endpoint (`POST /api/oauth/introspect`) | `server/routes/oauth.js` | Done — RFC 7662 |
| Revoke endpoint (`POST /api/oauth/revoke`) | `server/routes/oauth.js` | Done — RFC 7009 |
| UserInfo endpoint (`GET /api/oauth/userinfo`) | `server/routes/oauth.js` | Done — OIDC |
| Authorize endpoint (`GET/POST /api/oauth/authorize`) | `server/routes/oauthAuthorize.js` | Done — Auth Code + PKCE + consent screen |
| Well-Known discovery (`/.well-known/openid-configuration`, `/.well-known/jwks.json`) | `server/routes/wellKnown.js` | Done |
| Admin CRUD for OAuth clients | `server/routes/admin/oauthClients.js` | Done — 8 endpoints |
| Client manager (bcrypt secrets, CRUD) | `server/utils/oauthClientManager.js` | Done |
| Token service (JWT generation/validation) | `server/utils/oauthTokenService.js` | Done |
| Authorization code store (in-memory, 10-min TTL) | `server/utils/authorizationCodeStore.js` | Done |
| Consent store (file-backed, 90-day memory) | `server/utils/consentStore.js` | Done |
| PKCE utils (S256) | `server/utils/pkceUtils.js` | Done |
| Refresh token store (file-backed, bcrypt, single-use) | `server/utils/refreshTokenStore.js` | Done |
| JWT auth middleware extended for OAuth tokens | `server/middleware/jwtAuth.js` | Done |

### Client-Side (Admin UI)

| Component | File | Status |
|---|---|---|
| OAuth Clients list page | `client/src/features/admin/pages/AdminOAuthClientsPage.jsx` | Done |
| OAuth Client edit/create page | `client/src/features/admin/pages/AdminOAuthClientEditPage.jsx` | Done |
| Admin navigation link | `client/src/features/admin/components/AdminNavigation.jsx` | Done |
| Routes in App.jsx | `client/src/App.jsx` (lines 58-62, 384-389) | Done |

### Configuration

- **Platform config** (`server/defaults/config/platform.json`): OAuth section present with `enabled`, `clientsFile`, token expiration, auth code settings, refresh token settings, consent memory
- **Default is `enabled: false`** — needs to be turned on for testing
- **Migrations**: V007 (auth code flow setup) and V008 (rate limiting) exist

### Documentation

- `docs/oauth-integration-guide.md` — Client Credentials flow
- `docs/oauth-authorization-code.md` — Authorization Code flow
- `docs/jwt-well-known-endpoints.md` — JWKS/discovery
- `docs/ihub-as-oidc-idp.md` — iHub as OIDC IdP
- `concepts/OAUTH_IMPLEMENTATION_SUMMARY.md` — Overview
- `concepts/oauth-authorization-code/` — 11 detailed design docs

### Example App

- `examples/oauth-client/` — Full Express.js app demonstrating Authorization Code + PKCE
- Supports confidential and public client modes
- Login, callback, dashboard, token refresh, logout (with revocation)
- Well-documented README

### Tests

- `tests/oauth-flow-test.js` — E2E flow test
- `tests/oauth-auth-code-unit.js` — Auth code unit tests
- `tests/test-client-secret-preservation.js` — Secret preservation tests

### i18n

- English and German translations for OAuth UI strings

---

## Bugs — Must Fix Before Testing

### BUG 1 (Critical): JWT Audience Mismatch Breaks Authorization Code Tokens

**Impact:** Authorization code tokens cannot be verified by the jwtAuth middleware — all protected API calls with OAuth access tokens fail silently (treated as unauthenticated).

**Root cause:** When authorization_code tokens are generated (`server/routes/oauth.js:279-288`), the `additionalClaims` includes `aud: codeData.clientId` (the OAuth client ID). However, `verifyJwt()` in `server/utils/tokenService.js:171-174` always verifies with `audience: 'ihub-apps'`:

```js
// tokenService.js:171-174
return jwt.verify(token, verificationKey, {
  issuer: 'ihub-apps',
  audience: 'ihub-apps',  // <-- hardcoded, doesn't match clientId
  algorithms: [algorithm]
});
```

Since `aud: clientId` !== `'ihub-apps'`, `jwt.verify()` throws, `verifyJwt()` returns `null`, and jwtAuth treats the request as anonymous.

**Consequence:** The `/api/oauth/userinfo` endpoint returns 401. Any resource server calling iHub APIs with an OAuth access token gets unauthenticated responses. The `oauth_authorization_code` branch in `jwtAuth.js:174` is unreachable.

**Fix:** `verifyJwt()` needs to accept an optional audience parameter, or authorization_code tokens need to use `audience: 'ihub-apps'` like client_credentials tokens do.

### BUG 2: Token Introspection Only Works for client_credentials

**Impact:** Introspection returns `{ active: false }` for valid authorization_code tokens.

**Root cause:** `introspectOAuthToken()` in `server/utils/oauthTokenService.js:100` checks `decoded.authMode !== 'oauth_client_credentials'` and returns null for any other mode.

**Fix:** Add handling for `oauth_authorization_code` authMode in the introspection function.

### BUG 3: `end_session_endpoint` Advertised but Not Implemented

**Impact:** Any OIDC relying party that follows the discovery document to perform RP-initiated logout will get a 404.

**Root cause:** `server/routes/wellKnown.js:114` advertises `end_session_endpoint: ${baseUrl}/api/oauth/logout`, but no `/api/oauth/logout` route exists. The client model already has a `postLogoutRedirectUris` field, suggesting this was planned.

**Fix:** Either implement the endpoint or remove it from the discovery document.

### BUG 4: `client_secret_basic` Advertised but Not Supported

**Impact:** Standard OAuth libraries configured with `client_secret_basic` authentication will fail at the token endpoint.

**Root cause:** The discovery document declares support for `client_secret_basic` (`wellKnown.js:118`), but the token endpoint only reads credentials from `req.body` (client_secret_post). No HTTP Basic `Authorization` header parsing exists.

**Fix:** Either implement Basic auth header parsing in the token endpoint or remove the claim from the discovery document.

---

## Gaps — Should Fix

1. **No scope validation in authorization code flow** — The authorize endpoint accepts any scopes without checking them against the client's registered scopes. The client_credentials flow correctly validates scopes in `oauthTokenService.js:38-48`, but this check is absent from the auth code path.

2. **No `offline_access` scope enforcement** — Refresh tokens are issued whenever the client has `refresh_token` in its `grantTypes` array, regardless of whether the client requested the `offline_access` scope. Per OIDC spec, refresh tokens should only be issued when `offline_access` is explicitly requested.

3. **No rate limiting on public OAuth endpoints** — The public-facing endpoints (`/api/oauth/token`, `/api/oauth/introspect`, `/api/oauth/revoke`, `/api/oauth/authorize`) have no rate limiting. The token endpoint is a brute-force target. (Note: V008 migration adds a rate limit config key, but it's unclear if it's wired up to these routes.)

---

## Minor Issues

1. **OAuth is disabled by default** — `platform.json` has `"oauth.enabled": false` and `"authorizationCodeEnabled": false`. These need to be enabled to test.

2. **In-memory authorization code store** — `authorizationCodeStore.js` is in-memory, so auth codes are lost on server restart. Acceptable for single-instance but not clustered deployments.

3. **No PKCE downgrade protection for confidential clients** — Confidential clients can skip PKCE. OAuth 2.1 recommends PKCE for all clients.

4. **ID token `at_hash` uses string truncation** — `oauth.js:300-303` uses `substring(0, 22)` on base64url instead of byte-level truncation. Could produce incorrect values in edge cases.

5. **Consent store concurrency** — `consentStore.js` reads the entire JSON file on every `hasConsent()` call. Concurrent writes can lose data (last writer wins).

---

## Testing Plan

To test the OAuth Authorization Server end-to-end with the example app:

### Step 1: Enable OAuth in platform config

Edit `contents/config/platform.json` and set:

```json
{
  "oauth": {
    "enabled": true,
    "authorizationCodeEnabled": true,
    "refreshTokenEnabled": true
  }
}
```

### Step 2: Start iHub

```bash
npm run dev
```

### Step 3: Create an OAuth client via Admin UI

1. Navigate to `http://localhost:3000/admin/oauth/clients`
2. Create a new client with:
   - **Client Type**: `confidential`
   - **Grant Types**: `authorization_code`, `refresh_token`
   - **Redirect URIs**: `http://localhost:8080/callback`
3. Note the **Client ID** and **Client Secret** (shown only once)

### Step 4: Configure and start the example app

```bash
cd examples/oauth-client
cp .env.example .env
# Edit .env with CLIENT_ID and CLIENT_SECRET from step 3
npm install
npm start
```

### Step 5: Test the Authorization Code flow

> **Note:** Due to BUG 1 (audience mismatch), the userinfo call will fail with 401 after token exchange. The token exchange itself (code → tokens) should succeed, and the dashboard will show decoded JWT claims (client-side decode). But any server-side token verification will fail until BUG 1 is fixed.

1. Open `http://localhost:8080`
2. Click "Login with iHub"
3. You'll be redirected to iHub's authorize endpoint
4. Log in (if not already) and consent
5. You'll land on the dashboard showing decoded token claims
6. Test "Refresh Token" button
7. Test "Logout" (verifies token revocation)

### Step 6: Verify Well-Known endpoints

```bash
curl http://localhost:3000/.well-known/openid-configuration
curl http://localhost:3000/.well-known/jwks.json
```

### Step 7: Test Client Credentials flow (bonus)

```bash
curl -X POST http://localhost:3000/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"<id>","client_secret":"<secret>"}'
```

---

## Verdict

The OAuth authorization server implementation is **structurally complete** — all three grant types, admin UI, consent screen, OIDC discovery, JWKS, token introspection/revocation, and the example app are in place.

However, **the authorization code flow has a critical blocking bug** (JWT audience mismatch) that prevents OAuth access tokens from being verified by the jwtAuth middleware. The client_credentials flow works correctly.

**Before testing the authorization code flow end-to-end**, the 4 bugs listed above need to be fixed. The client_credentials flow can be tested immediately by enabling OAuth in the config.
