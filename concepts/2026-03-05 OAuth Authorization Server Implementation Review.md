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

## What Is Missing / Needs Attention

Based on the review, the implementation appears **feature-complete**. The potential gaps are minor:

1. **OAuth is disabled by default** — `platform.json` has `"oauth.enabled": false` and `"authorizationCodeEnabled": false`. These need to be enabled to test.

2. **No automated integration test suite** — The test files in `tests/` are standalone scripts, not part of a CI test runner. They require a running server.

3. **In-memory authorization code store** — `authorizationCodeStore.js` is in-memory, so auth codes are lost on server restart. This is acceptable for single-instance deployments but won't work with clustering. (Consent and refresh tokens are file-backed, which is fine.)

4. **No PKCE downgrade protection for confidential clients** — The code allows confidential clients to skip PKCE. OAuth 2.1 recommends PKCE for all clients. The example app already uses PKCE for both modes, so this is a minor concern.

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

The OAuth authorization server implementation is **essentially complete**. All three grant types (`client_credentials`, `authorization_code`, `refresh_token`), admin UI, consent screen, OIDC discovery, JWKS, token introspection/revocation, and the example app are all in place. The main action needed is to **enable it in the config and test it end-to-end**.

No code changes are needed — the implementation is ready for testing.
