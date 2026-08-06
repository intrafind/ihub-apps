# OAuth Authorization Endpoint and Consent Screen

**Date:** 2026-02-25
**Task:** Task 5 - Authorize Endpoint + Consent Screen
**Status:** Completed

---

## Overview

This document describes the implementation of the OAuth 2.0 Authorization Code Flow authorization endpoint (RFC 6749 §4.1 + RFC 7636 PKCE). It is intended for junior developers who need to understand, debug, or extend this feature.

---

## What Was Implemented

Three changes across three files:

### 1. `server/middleware/setup.js` — OAuth Session Middleware

A new `express-session` block was added inside `setupSessionMiddleware()` after the integration session block. It registers session middleware scoped to `/api/oauth` only.

**Why it is needed:**
The OAuth authorization flow redirects users to the login page when they are not authenticated. After login, the user is redirected back to the `GET /api/oauth/authorize` endpoint. The original OAuth query parameters (client_id, redirect_uri, PKCE challenge, etc.) must survive across that redirect. Sessions are the standard mechanism for this.

**Session configuration:**
- Cookie name: `oauth.session`
- TTL: 15 minutes (auth code flow is short-lived by design)
- `saveUninitialized: true` — required so the session is created and the cookie is sent before the login redirect
- Scoped to `/api/oauth` path — does not apply to other routes

**Condition:** Only activated when `platform.oauth.enabled === true` or `platform.oauth.authorizationCodeEnabled === true`.

---

### 2. `server/routes/oauthAuthorize.js` — New Route File

Exports a single function `registerOAuthAuthorizeRoutes(app)` that registers two Express routes.

#### Route 1: `GET /api/oauth/authorize`

The browser-facing authorization endpoint. Called by third-party apps when initiating the OAuth flow.

**Request parameters (query string):**

| Parameter              | Required | Description |
|------------------------|----------|-------------|
| `response_type`        | Yes      | Must be `"code"` |
| `client_id`            | Yes      | OAuth client identifier |
| `redirect_uri`         | Yes      | Must exactly match a registered redirect URI |
| `scope`                | No       | Space-separated scopes; defaults to `"openid"` |
| `state`                | No       | Anti-CSRF state value owned by the calling app |
| `code_challenge`       | Yes*     | PKCE S256 challenge (*required for public clients) |
| `code_challenge_method`| Yes*     | Must be `"S256"` for public clients |
| `nonce`                | No       | Nonce for ID token binding |

**Decision logic:**

```
1. OAuth feature enabled?           → No  → 400 error
2. response_type == "code"?         → No  → 400 error
3. client_id present?               → No  → 400 error
4. Client found and active?         → No  → 400 error
5. Client grants "authorization_code"? → No → 400 error
6. redirect_uri present and valid?  → No  → 400 error
7. Is public client without PKCE?   → Yes → redirect with error
8. User authenticated (JWT cookie)? → No  → save params in session, redirect to /login
9. Client is trusted/no-consent?    → Yes → generate code, redirect to redirect_uri
10. Otherwise                            → show consent screen
```

#### Route 2: `POST /api/oauth/authorize/decision`

Handles the consent form submission (allow / deny).

**Request body (form-encoded):**

| Field          | Description |
|----------------|-------------|
| `_csrf`        | CSRF token from the hidden form field |
| `client_id`    | OAuth client identifier |
| `redirect_uri` | Redirect URI |
| `state`        | State value to pass back |
| `scope`        | Space-separated scopes |
| `decision`     | `"allow"` or `"deny"` |
| `nonce`        | Optional nonce |

**Security measures:**
1. CSRF token verification using `crypto.timingSafeEqual` (prevents timing attacks)
2. CSRF token is single-use (deleted from session after verification)
3. redirect_uri re-validated against client allowlist
4. User re-authenticated via JWT cookie (session could have expired during consent)
5. PKCE params retrieved from session (not from form — prevents tampering)

---

### 3. `server/server.js` — Route Registration

Added two lines:
- Import of `registerOAuthAuthorizeRoutes` from `./routes/oauthAuthorize.js`
- Call to `registerOAuthAuthorizeRoutes(app)` immediately after `registerOAuthRoutes(app)`

---

## Key Design Decisions

### Why separate file instead of extending `oauth.js`?

The specification required it as a separate file (`oauthAuthorize.js`). The authorization endpoint is browser-facing (returns HTML, performs redirects) while `oauth.js` handles JSON API endpoints (token, introspect, revoke). Separation of concerns also makes each file easier to test independently.

### Why `saveUninitialized: true` for OAuth sessions?

When an unauthenticated user arrives at `GET /api/oauth/authorize`, we need to:
1. Store the OAuth parameters in the session
2. Set the session cookie
3. Redirect to `/login`

If `saveUninitialized: false`, no session would be created and the cookie would not be sent, meaning the OAuth params would be lost. The session is only 15 minutes and only applies to `/api/oauth` paths, so the memory cost is minimal.

### Why no PKCE for confidential clients?

RFC 7636 makes PKCE mandatory for public clients (SPAs, native apps) that cannot securely store a client secret. Confidential clients (server-side apps) may use PKCE optionally but it is not enforced here. The `code_challenge` and `code_challenge_method` parameters are captured and stored when present, so the token endpoint can verify them regardless.

### Why exact redirect_uri matching?

RFC 6749 §3.1.2 recommends exact matching to prevent open redirect attacks. No wildcards, no path prefix matching.

### Why re-validate on POST /decision?

The JWT cookie could expire between `GET /authorize` and `POST /decision`. Re-reading from the cookie (not from session) ensures we always get a fresh authentication check.

---

## Consent Screen

The consent screen is a self-contained HTML page with inline CSS. It has no external dependencies (no CDN, no JavaScript) for security and reliability.

**Scope descriptions displayed:**

| Scope            | Description shown to user |
|------------------|--------------------------|
| `openid`         | Verify your identity |
| `profile`        | Access your name and profile information |
| `email`          | Access your email address |
| `offline_access` | Access resources when you are not actively using the app (refresh tokens) |

Custom/unknown scopes are shown by name only, without a description.

**XSS prevention:** All user-supplied values are passed through `escapeHtml()` before being embedded in the HTML. This covers client name, all hidden field values, and any dynamic content.

---

## How to Test Manually

1. Enable OAuth in `contents/config/platform.json`:
   ```json
   {
     "oauth": {
       "enabled": true
     }
   }
   ```

2. Create an OAuth client (via admin UI or directly in `contents/config/oauth-clients.json`) with:
   - `grantTypes: ["authorization_code"]`
   - `redirectUris: ["http://localhost:8080/callback"]`
   - `consentRequired: true` (to see the consent screen)

3. Navigate to:
   ```
   http://localhost:3000/api/oauth/authorize?
     response_type=code&
     client_id=YOUR_CLIENT_ID&
     redirect_uri=http://localhost:8080/callback&
     scope=openid%20profile&
     state=random123
   ```

4. If not logged in, you will be redirected to `/login?returnUrl=...`
5. After login, you will see the consent screen
6. After clicking Allow, you will be redirected to `http://localhost:8080/callback?code=...&state=random123`

---

## Files Changed

| File | Change |
|------|--------|
| `server/middleware/setup.js` | Added OAuth session block inside `setupSessionMiddleware()` |
| `server/routes/oauthAuthorize.js` | **New file** — authorization endpoint and consent screen |
| `server/server.js` | Added import and registration call for `oauthAuthorize.js` |

---

## Dependencies on Other Tasks

- **Task 3** (authorizationCodeStore, pkceUtils): `generateCode()` and `storeCode()` must be present.
- **Task 2** (oauthClientManager): `findClientById()` and `loadOAuthClients()` must be present.
- **Task 1** (jwtAuth RS256): `verifyJwt()` in tokenService must work correctly.
- **Task 6** (Token endpoint): Reads the stored authorization code via `consumeCode()`.
