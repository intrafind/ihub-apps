# OAuth 2.0 Authorization Code Flow

This document is the primary developer reference for implementing OAuth 2.0 Authorization Code login against iHub Apps. After reading this, you should be able to build a working OAuth login integration from scratch.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [PKCE Requirement](#pkce-requirement)
4. [Step-by-Step Flow](#step-by-step-flow)
5. [API Endpoint Reference](#api-endpoint-reference)
6. [Client Configuration Reference](#client-configuration-reference)
7. [Complete Code Example](#complete-code-example)
8. [Token Format and Claims](#token-format-and-claims)
9. [Scopes](#scopes)
10. [Error Handling](#error-handling)
11. [Security Checklist](#security-checklist)
12. [Troubleshooting](#troubleshooting)

## Overview

The OAuth 2.0 Authorization Code Flow allows external applications to authenticate users through iHub Apps and receive tokens that represent the user's identity and permissions. This is the standard flow for web applications, SPAs, and mobile apps that need to log users in via iHub.

iHub acts as the **Authorization Server** and **Identity Provider (IdP)**. Your application is the **Client** (also called Relying Party). The user is the **Resource Owner**.

**Supported grant types for this flow:**

- `authorization_code` — initial token exchange after user login
- `refresh_token` — obtain a new access token without user interaction

**When to use this flow:**

- You want users to log in to your application using their iHub credentials
- You need to know who the user is and what permissions they have
- Your application is a web app, SPA, or mobile app (i.e., has a user interface)

For server-to-server API access without a logged-in user, use the [Client Credentials flow](oauth-integration-guide.md) instead.

## Prerequisites

### 1. Enable OAuth in platform configuration

Add the `oauth` block to `contents/config/platform.json` and restart the server:

```json
{
  "oauth": {
    "enabled": true,
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440,
    "consentMemoryDays": 90
  }
}
```

> OAuth configuration requires a server restart to take effect. Other configuration changes do not.

### 2. Ensure JWT uses RS256

The Authorization Code flow issues RS256-signed access tokens and id_tokens. Verify your JWT configuration in `contents/config/platform.json`:

```json
{
  "jwt": {
    "algorithm": "RS256"
  }
}
```

RS256 is the default. If you previously set `HS256`, switch it back to `RS256` and restart.

### 3. Create an OAuth client

Use the admin API to register your application as an OAuth client:

```bash
curl -X POST https://your-ihub-instance.com/api/admin/oauth/clients \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Web App",
    "description": "User-facing application that logs in via iHub",
    "clientType": "public",
    "grantTypes": ["authorization_code", "refresh_token"],
    "redirectUris": ["https://my-app.example.com/auth/callback"],
    "scopes": ["openid", "profile", "email"],
    "consentRequired": true,
    "trusted": false
  }'
```

Save the returned `clientId`. Public clients do not have a `clientSecret`.

For a confidential client (server-side app with a backend), use `"clientType": "confidential"` and save both the `clientId` and `clientSecret`.

## PKCE Requirement

PKCE (Proof Key for Code Exchange, RFC 7636) prevents authorization code interception attacks. iHub supports the `S256` method only.

**Public clients must use PKCE.** PKCE is optional but recommended for confidential clients.

### How PKCE works

Before starting the flow, your application generates two values:

1. **`code_verifier`** — a cryptographically random string (43–128 characters, URL-safe)
2. **`code_challenge`** — the SHA-256 hash of the verifier, base64url-encoded

```javascript
// Node.js example
import crypto from 'crypto';

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

const codeVerifier = generateCodeVerifier();
const codeChallenge = generateCodeChallenge(codeVerifier);
```

The `code_challenge` is sent in the authorization request. The `code_verifier` is sent when exchanging the authorization code for tokens. iHub verifies that `SHA256(code_verifier) === code_challenge`, proving that the entity exchanging the code is the same one that initiated the flow.

## Step-by-Step Flow

```
Your App                    Browser                    iHub
   |                           |                         |
   |-- generate PKCE params    |                         |
   |-- build auth URL -------->|                         |
   |                           |-- GET /api/oauth/authorize -->|
   |                           |                         |-- validate params
   |                           |                         |-- check login state
   |                           |<- redirect to /login (if not logged in)
   |                           |-- user logs in -------->|
   |                           |<- redirect back --------|
   |                           |-- show consent screen --|
   |                           |-- user clicks Allow --->|
   |                           |<- redirect to callback--|
   |<-- receive ?code=XYZ -----|                         |
   |-- POST /api/oauth/token with code + verifier ------>|
   |<-- access_token, id_token, refresh_token -----------|
   |-- GET /api/oauth/userinfo with access_token ------->|
   |<-- user profile -----------------------------------|
```

### Step 1: Generate PKCE parameters

Generate `code_verifier` and `code_challenge` as described above. Store `code_verifier` securely in your application (session, local storage for SPAs).

### Step 2: Build the authorization URL

Construct the URL for `GET /api/oauth/authorize`:

```
https://your-ihub-instance.com/api/oauth/authorize
  ?response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=https://my-app.example.com/auth/callback
  &scope=openid+profile+email
  &state=RANDOM_STATE_VALUE
  &code_challenge=BASE64URL_SHA256_OF_VERIFIER
  &code_challenge_method=S256
  &nonce=RANDOM_NONCE_VALUE
```

**Required parameters:**

| Parameter | Value |
|---|---|
| `response_type` | Always `code` |
| `client_id` | Your registered client ID |
| `redirect_uri` | Must exactly match a registered URI |
| `scope` | Space-separated list, e.g. `openid profile email` |

**Recommended parameters:**

| Parameter | Description |
|---|---|
| `state` | Random value to prevent CSRF — verify it on callback |
| `code_challenge` | Base64url(SHA256(code_verifier)) |
| `code_challenge_method` | Always `S256` |
| `nonce` | Random value included in the id_token — verify it to prevent replay |

### Step 3: Redirect the user

Redirect the user's browser to the authorization URL. iHub will:

1. Check if the user is logged in. If not, redirect them to the iHub login page.
2. After login, redirect back to the authorization endpoint.
3. If `consentRequired` is true for the client, show a consent screen.
4. If the user grants access (or consent was already granted), redirect to your `redirect_uri` with `?code=AUTHORIZATION_CODE&state=YOUR_STATE`.

### Step 4: Receive the callback

Your callback endpoint receives the authorization code:

```
GET https://my-app.example.com/auth/callback?code=AUTH_CODE&state=STATE
```

**Before proceeding:**

1. Verify the `state` parameter matches what you sent in step 2.
2. Extract the `code` parameter.

### Step 5: Exchange the code for tokens

Send a `POST` request to the token endpoint:

```bash
curl -X POST https://your-ihub-instance.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "AUTHORIZATION_CODE",
    "redirect_uri": "https://my-app.example.com/auth/callback",
    "client_id": "YOUR_CLIENT_ID",
    "code_verifier": "YOUR_ORIGINAL_CODE_VERIFIER"
  }'
```

For confidential clients, include the `client_secret` instead of (or in addition to) the `code_verifier`:

```bash
curl -X POST https://your-ihub-instance.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "AUTHORIZATION_CODE",
    "redirect_uri": "https://my-app.example.com/auth/callback",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }'
```

**Response:**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "id_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid profile email"
}
```

### Step 6: Fetch user information

Use the `access_token` to call the UserInfo endpoint:

```bash
curl https://your-ihub-instance.com/api/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

**Response:**

```json
{
  "sub": "user@example.com",
  "name": "Jane Doe",
  "email": "user@example.com",
  "groups": ["users", "authenticated"]
}
```

### Step 7: Refresh the access token

When the access token expires, use the refresh token to get a new one:

```bash
curl -X POST https://your-ihub-instance.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "refresh_token",
    "refresh_token": "YOUR_REFRESH_TOKEN",
    "client_id": "YOUR_CLIENT_ID"
  }'
```

> Refresh tokens are only issued when `offline_access` is in the requested scopes and the client has `refresh_token` in its `grantTypes` array.

## API Endpoint Reference

### Authorization Endpoint

```
GET /api/oauth/authorize
```

Initiates the authorization code flow. Parameters are passed as query strings.

**Query Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `response_type` | Yes | Must be `code` |
| `client_id` | Yes | Registered OAuth client ID |
| `redirect_uri` | Yes | Must exactly match a registered URI |
| `scope` | No | Space-separated scopes; defaults to `openid` |
| `state` | Recommended | Opaque value passed through unchanged |
| `nonce` | Recommended | Random value embedded in `id_token` |
| `code_challenge` | Required for public clients | `base64url(sha256(code_verifier))` |
| `code_challenge_method` | Required for public clients | Must be `S256` |

**Success response:** HTTP 302 redirect to `redirect_uri?code=AUTH_CODE&state=STATE`

**Error response:** HTTP 302 to `redirect_uri?error=ERROR_CODE&error_description=DESCRIPTION&state=STATE` (or HTTP 400 for fatal errors before redirect_uri is validated)

---

### Token Endpoint

```
POST /api/oauth/token
Content-Type: application/json
```

Exchanges an authorization code for tokens, refreshes an access token, or issues client credentials tokens.

**Authorization Code Grant:**

| Field | Required | Description |
|---|---|---|
| `grant_type` | Yes | `authorization_code` |
| `code` | Yes | The authorization code from the callback |
| `redirect_uri` | Yes | Must match the value used in the authorization request |
| `client_id` | Yes | Your client ID |
| `code_verifier` | Required for public clients | Original PKCE verifier |
| `client_secret` | Required for confidential clients | Client secret |

**Refresh Token Grant:**

| Field | Required | Description |
|---|---|---|
| `grant_type` | Yes | `refresh_token` |
| `refresh_token` | Yes | A valid refresh token |
| `client_id` | Yes | Your client ID |
| `client_secret` | Confidential clients only | Client secret |

**Response:**

| Field | Description |
|---|---|
| `access_token` | RS256-signed JWT for API authorization |
| `id_token` | RS256-signed JWT with user identity claims |
| `refresh_token` | Opaque token for obtaining new access tokens |
| `token_type` | Always `Bearer` |
| `expires_in` | Seconds until `access_token` expires |
| `scope` | Space-separated list of granted scopes |

---

### UserInfo Endpoint

```
GET /api/oauth/userinfo
Authorization: Bearer ACCESS_TOKEN
```

Returns user profile information for the user represented by the access token.

**Response:**

```json
{
  "sub": "user@example.com",
  "name": "Jane Doe",
  "email": "user@example.com",
  "groups": ["users", "authenticated"]
}
```

---

### Revocation Endpoint

```
POST /api/oauth/revoke
Content-Type: application/json
```

Revokes an access or refresh token. After revocation, the token is no longer valid.

**Request:**

```json
{
  "token": "TOKEN_TO_REVOKE",
  "client_id": "YOUR_CLIENT_ID"
}
```

**Response:** HTTP 200 (no body) on success.

---

### Discovery Endpoint

```
GET /.well-known/openid-configuration
```

Returns OIDC Discovery metadata. See [Using iHub as OIDC Identity Provider](ihub-as-oidc-idp.md) for details.

## Client Configuration Reference

OAuth clients are stored in `contents/config/oauth-clients.json`. They can be managed via the Admin UI or the admin API.

### Client Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | Auto-generated | Unique identifier for the client |
| `clientSecret` | string | Confidential clients only | Hashed secret; shown once on creation |
| `name` | string | Yes | Human-readable display name |
| `description` | string | No | Optional description |
| `clientType` | `"public"` \| `"confidential"` | Yes | `public` for SPAs/mobile; `confidential` for server-side apps |
| `grantTypes` | string[] | Yes | Must include `"authorization_code"`; add `"refresh_token"` to enable refresh |
| `redirectUris` | string[] | Yes | Allowed redirect URIs; exact match only, no wildcards |
| `scopes` | string[] | No | Allowed scopes; defaults to all standard scopes |
| `trusted` | boolean | No | If `true`, skips consent screen and issues code immediately |
| `consentRequired` | boolean | No | If `false`, skips consent screen (same as `trusted`) |
| `tokenExpirationMinutes` | number | No | Override default access token lifetime |
| `active` | boolean | No | Set to `false` to suspend the client |

### Public vs Confidential Clients

**Public clients** (`clientType: "public"`) are for applications that cannot keep a secret:

- Single-page applications (SPAs)
- Mobile and desktop applications
- Any client where the source code is visible to end users
- Must use PKCE (`code_challenge` + `code_verifier` with `S256`)
- No `clientSecret`

**Confidential clients** (`clientType: "confidential"`) are for applications with a secure backend:

- Server-rendered web applications
- Backend services with a user-facing login flow
- Have a `clientSecret` that must be kept private
- May use PKCE in addition to the client secret for extra security

### Consent and Trust Settings

By default, users see a consent screen listing the scopes your application requests. The consent decision is remembered for `consentMemoryDays` days (default 90).

To skip the consent screen entirely (appropriate for first-party applications):

```json
{
  "trusted": true,
  "consentRequired": false
}
```

> Use trusted clients carefully. They bypass user consent, meaning users cannot deny access.

## Complete Code Example

The following is a minimal but complete implementation of the Authorization Code Flow for a Node.js web application.

```javascript
import express from 'express';
import crypto from 'crypto';
import session from 'express-session';

const app = express();
const IHUB_URL = 'https://your-ihub-instance.com';
const CLIENT_ID = 'your_client_id';
const REDIRECT_URI = 'http://localhost:4000/auth/callback';

app.use(session({ secret: 'app-session-secret', resave: false, saveUninitialized: false }));

/**
 * Generate a URL-safe random string suitable for use as a PKCE code_verifier
 * or as a state/nonce parameter.
 *
 * @param {number} byteLength - Number of random bytes to generate.
 * @returns {string} Base64url-encoded random string.
 */
function randomBase64url(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Compute the PKCE code_challenge from a code_verifier using S256 method.
 *
 * @param {string} verifier - The code_verifier string.
 * @returns {string} Base64url-encoded SHA-256 hash of the verifier.
 */
function s256Challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Initiate the OAuth login flow.
 * Generates PKCE parameters and state, stores them in session,
 * then redirects to the iHub authorization endpoint.
 */
app.get('/login', (req, res) => {
  const codeVerifier = randomBase64url();
  const codeChallenge = s256Challenge(codeVerifier);
  const state = randomBase64url(16);
  const nonce = randomBase64url(16);

  // Store in session so we can verify them on callback
  req.session.oauth = { codeVerifier, state, nonce };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`${IHUB_URL}/api/oauth/authorize?${params}`);
});

/**
 * Handle the callback from iHub after user authentication and consent.
 * Verifies state, exchanges the code for tokens, and fetches user info.
 */
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Handle user denial or other errors from iHub
  if (error) {
    return res.status(400).send(`Authorization error: ${error}`);
  }

  const savedOauth = req.session.oauth;
  if (!savedOauth) {
    return res.status(400).send('No OAuth session found. Please start the login flow again.');
  }

  // Verify state to prevent CSRF attacks
  if (state !== savedOauth.state) {
    return res.status(400).send('State mismatch. Possible CSRF attack.');
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(`${IHUB_URL}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: savedOauth.codeVerifier
    })
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.json().catch(() => ({}));
    return res.status(400).send(`Token exchange failed: ${err.error || tokenResponse.statusText}`);
  }

  const tokens = await tokenResponse.json();

  // Fetch user information
  const userResponse = await fetch(`${IHUB_URL}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });

  const userInfo = await userResponse.json();

  // Store tokens and user in session
  req.session.user = userInfo;
  req.session.accessToken = tokens.access_token;
  req.session.refreshToken = tokens.refresh_token;
  delete req.session.oauth;

  res.redirect('/dashboard');
});

/**
 * Example protected route that requires authentication.
 */
app.get('/dashboard', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  res.send(`Hello, ${req.session.user.name}! Your groups: ${req.session.user.groups.join(', ')}`);
});

/**
 * Refresh the access token using a stored refresh token.
 * Call this when you receive a 401 from an API and have a refresh token.
 *
 * @param {string} refreshToken - A valid refresh token.
 * @returns {Promise<Object>} New token response with access_token and optionally refresh_token.
 */
async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${IHUB_URL}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    })
  });

  if (!response.ok) {
    throw new Error('Refresh token is invalid or expired. User must log in again.');
  }

  return response.json();
}

app.listen(4000, () => console.log('App running on http://localhost:4000'));
```

## Token Format and Claims

Access tokens and ID tokens are RS256-signed JWTs. You can validate them using the public key from `/.well-known/jwks.json`.

### Access Token Claims

| Claim | Type | Description |
|---|---|---|
| `sub` | string | Subject — user identifier (typically email or username) |
| `email` | string | User's email address |
| `name` | string | User's display name |
| `groups` | string[] | User's resolved iHub group memberships |
| `iss` | string | Issuer — base URL of the iHub server |
| `aud` | string | Audience — `clientId` of the OAuth client |
| `iat` | number | Issued-at timestamp (Unix epoch) |
| `exp` | number | Expiration timestamp (Unix epoch) |
| `scope` | string | Space-separated list of granted scopes |

### ID Token Claims

The ID token includes the same claims as the access token, plus:

| Claim | Type | Description |
|---|---|---|
| `nonce` | string | The `nonce` value from the authorization request (if provided) |

### Verifying tokens

If your backend receives access tokens from clients, validate them using the JWKS endpoint:

```javascript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL('https://your-ihub-instance.com/.well-known/jwks.json')
);

async function verifyToken(token, clientId) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: 'https://your-ihub-instance.com',
    audience: clientId,
    algorithms: ['RS256']
  });
  return payload;
}
```

> The `issuer` value is the base URL of your iHub server. It can be overridden via `platform.oauth.issuer` in platform configuration.

## Scopes

| Scope | Description |
|---|---|
| `openid` | Required for OIDC flows; enables id_token |
| `profile` | Grants access to `name` and other profile claims |
| `email` | Grants access to the `email` claim |
| `offline_access` | Requests a refresh token for long-lived access |

## Error Handling

### Authorization Endpoint Errors

Errors that occur before the redirect_uri is validated are returned as plain HTTP 400 responses. Once the redirect_uri is validated, errors are sent as redirects:

```
https://my-app.example.com/callback?error=ERROR_CODE&error_description=MESSAGE&state=STATE
```

| Error Code | Cause |
|---|---|
| `invalid_request` | Missing or invalid parameters |
| `unauthorized_client` | Client does not support the requested grant type |
| `access_denied` | User denied the consent request |
| `unsupported_response_type` | Only `code` is supported |
| `invalid_scope` | Requested scope is not allowed for this client |
| `server_error` | Unexpected server error |

### Token Endpoint Errors

Token errors are returned as JSON with HTTP 4xx status:

```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code has expired or is invalid"
}
```

| Error Code | Cause |
|---|---|
| `invalid_client` | Unknown client_id or wrong client_secret |
| `invalid_grant` | Code is expired, already used, or PKCE verification failed |
| `invalid_request` | Missing required parameters |
| `unsupported_grant_type` | The grant type is not supported by this client |

## Security Checklist

Before going to production, verify the following:

- [ ] All redirect URIs are registered exactly (no wildcards, no trailing slashes unless intentional)
- [ ] The `state` parameter is validated on every callback to prevent CSRF
- [ ] The `nonce` is validated in the id_token if you sent one
- [ ] PKCE is used for all public clients (`code_challenge_method: S256`)
- [ ] The `code_verifier` is not logged or transmitted to third parties
- [ ] Tokens are stored securely (HttpOnly cookies or server-side session, not localStorage)
- [ ] Your application uses HTTPS in all environments that receive tokens
- [ ] Refresh tokens are treated as secrets and stored appropriately
- [ ] Your callback endpoint returns an error for unexpected `state` values
- [ ] Tokens are revoked on logout (`POST /api/oauth/revoke`)
- [ ] Authorization codes are single-use (iHub enforces this server-side)
- [ ] The client secret (confidential clients) is stored as an environment variable, not in code

## Troubleshooting

### "redirect_uri not registered for this client"

The `redirect_uri` in your request must exactly match one of the URIs registered for the client. Check for:

- Protocol mismatch (`http` vs `https`)
- Trailing slash differences (`/callback` vs `/callback/`)
- Port differences (`localhost:4000` vs `localhost:4001`)

Update the registered `redirectUris` in the admin UI or admin API to match exactly.

### "PKCE with S256 is required for public clients"

Your client has `clientType: "public"` but the authorization request did not include `code_challenge` and `code_challenge_method=S256`. Add these parameters before redirecting the user.

### "Authorization code has expired or is invalid"

Authorization codes expire after 10 minutes and are single-use. This error means either:

- The code was used more than once (replay attack, or a browser back-button scenario)
- More than 10 minutes passed between receiving the code and exchanging it

Restart the flow by redirecting the user to the authorization endpoint again.

### "invalid_client" on token exchange

For confidential clients, ensure you are sending the correct `client_secret`. For public clients, ensure you are sending `code_verifier` (not `client_secret`).

### User is redirected to login repeatedly

If the user is sent to the iHub login page but is then redirected back to the authorization endpoint in a loop, check that:

- The iHub session cookie is being set correctly (requires `credentials: 'include'` for cross-origin requests)
- The iHub server is not deployed behind a proxy that strips `Set-Cookie` headers

### Refresh token is "invalid or expired"

Refresh tokens are long-lived but can be invalidated if:

- The OAuth client has its secret rotated
- The client is suspended (`active: false`)
- The refresh token itself has expired (configurable per client)

When refresh fails, redirect the user to the authorization endpoint to log in again.

## Related Documentation

- [OAuth Integration Guide (Client Credentials)](oauth-integration-guide.md) — machine-to-machine API access
- [Using iHub as OIDC Identity Provider](ihub-as-oidc-idp.md) — configuring OIDC libraries against iHub
- [JWT Well-Known Endpoints](jwt-well-known-endpoints.md) — JWKS and discovery endpoints
- [External Authentication](external-authentication.md) — iHub authentication modes overview
- [Platform Configuration](platform.md) — full platform.json reference

---

_Last updated: February 2026_
