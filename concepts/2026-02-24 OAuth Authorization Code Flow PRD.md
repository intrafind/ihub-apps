# OAuth 2.0 Authorization Code Flow PRD

## with PKCE, OIDC Identity Provider Capability & Example Client Application

| Field | Value |
|---|---|
| Document ID | PRD-2026-OAUTH-001 |
| Version | 2.0 |
| Date | February 24, 2026 |
| Author | Daniel Manzke |
| Status | Draft — Open Questions Resolved |
| Project | iHub Apps |
| Priority | High |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Current State Analysis](#3-current-state-analysis)
4. [Goals & Non-Goals](#4-goals--non-goals)
5. [Proposed Solution](#5-proposed-solution)
6. [Technical Architecture](#6-technical-architecture)
7. [API Specification](#7-api-specification)
8. [Security Requirements](#8-security-requirements)
9. [Admin UI Changes](#9-admin-ui-changes)
10. [OIDC Identity Provider Capability](#10-oidc-identity-provider-capability)
11. [Example Client Application](#11-example-client-application)
12. [Database / Storage Changes](#12-database--storage-changes)
13. [Configuration Changes](#13-configuration-changes)
14. [Migration & Backward Compatibility](#14-migration--backward-compatibility)
15. [Testing Strategy](#15-testing-strategy)
16. [Success Metrics](#16-success-metrics)
17. [Timeline & Milestones](#17-timeline--milestones)
18. [Resolved Decisions](#18-resolved-decisions)
19. [Appendix](#19-appendix)

---

## 1. Executive Summary

iHub Apps currently supports OAuth 2.0 client_credentials grant for machine-to-machine authentication and long-lived static API keys for simpler integrations. However, there is no mechanism for third-party client applications to authenticate on behalf of a user. This PRD defines the implementation of the OAuth 2.0 Authorization Code Grant with PKCE (Proof Key for Code Exchange), enabling external applications to securely obtain user-scoped access tokens by redirecting users through the iHub Apps login flow.

Beyond the authorization code flow, this PRD also establishes **iHub Apps as a full OIDC Identity Provider (IdP)**. This means other applications that support standard OIDC/OAuth authentication can use iHub as their authentication server. iHub acts as an **authentication broker** — it aggregates all configured authentication methods (NTLM, LDAP, OIDC upstream providers, local auth) behind a single OIDC-compliant interface. External applications only need to integrate with iHub once, regardless of the underlying authentication infrastructure.

The deliverables include the server-side authorization endpoints, the token exchange flow, id_token (OpenID Connect) support, a new client registration model with redirect URIs, Admin UI enhancements for managing OAuth clients, a consent screen, and a fully functional example client application that demonstrates the end-to-end OAuth flow in both confidential and public client modes.

---

## 2. Problem Statement

### 2.1 Current Limitations

The existing OAuth implementation has a critical gap: it only supports machine-to-machine authentication via client_credentials. While the `.well-known/openid-configuration` endpoint advertises support for `authorization_code` grant type, this flow is not actually implemented.

This means:

- Third-party applications cannot authenticate users through iHub Apps
- There is no way for an external web app to obtain a token scoped to a specific user
- The only options are static API keys (no user context) or client_credentials (machine identity)
- iHub cannot serve as a centralized authentication provider for other internal applications
- Organizations with complex auth setups (NTLM + LDAP + OIDC) cannot consolidate behind a single provider for their other apps

### 2.2 User Scenarios Not Supported

- **Scenario A:** A developer builds a custom dashboard that needs to call iHub APIs as the logged-in user, showing only the apps and models that user has access to.
- **Scenario B:** An internal application (e.g., a project management tool) wants to use iHub as its authentication provider via standard OIDC. Users log in once through iHub (which handles NTLM/LDAP/OIDC internally) and the application receives the user's identity.
- **Scenario C:** A mobile or desktop application wants to integrate iHub chat functionality, requiring user login without exposing credentials to the client.
- **Scenario D:** The organization wants to consolidate authentication across multiple internal tools. iHub already integrates with Active Directory, Authentik, etc. Other tools should be able to delegate authentication to iHub instead of each integrating separately.

---

## 3. Current State Analysis

### 3.1 Existing OAuth Components

| Component | Status | Details |
|---|---|---|
| Client Credentials Grant | **Implemented** | `POST /api/oauth/token` with `grant_type=client_credentials` |
| Static API Keys | **Implemented** | Admin-generated long-lived JWT tokens per client |
| Token Introspection | **Implemented** | `POST /api/oauth/introspect` validates tokens |
| OIDC User Login | **Implemented** | Users log in via external OIDC providers (e.g., Authentik) |
| Well-Known Discovery | **Implemented** | `/.well-known/openid-configuration` serves metadata |
| JWKS Endpoint | **Implemented** | `/.well-known/jwks.json` for RS256 key sharing |
| Authorization Code Grant | **Not Implemented** | Advertised in discovery but no endpoints exist |
| PKCE Support | **Not Implemented** | Required for public clients (SPAs, mobile apps) |
| Redirect URI Management | **Not Implemented** | OAuth clients have no `redirect_uri` configuration |
| Consent Screen | **Not Implemented** | No UI for user to approve client access |
| Refresh Tokens | **Not Implemented** | No refresh token mechanism for OAuth clients |
| id_token (OpenID Connect) | **Not Implemented** | No id_token issuance for user identity |

### 3.2 Existing Authentication Providers

iHub Apps supports multiple authentication methods. When a user is redirected to authorize a client app, they authenticate using whichever provider is configured. The authorization code flow must work with ALL of these transparently:

- **Local Auth:** Username/password stored in iHub
- **OIDC:** External providers (Authentik, Keycloak, Azure AD, etc.)
- **LDAP:** Directory-based authentication
- **NTLM:** Windows Integrated Authentication
- **Proxy Auth:** Header-based authentication from reverse proxies

### 3.3 Current Admin UI for OAuth Clients

The existing admin interface (`AdminOAuthClientEditPage.jsx`) supports creating and editing OAuth clients with these fields:

- Client name (required)
- Description (optional)
- Token expiration in minutes (1–1440)
- Active/inactive toggle
- Allowed apps (multi-select with wildcard support)
- Allowed models (multi-select with wildcard support)

The client list page (`AdminOAuthClientsPage.jsx`) provides actions for generating tokens, rotating secrets, enabling/disabling clients, and deleting clients. The Admin UI currently has no fields for redirect URIs, client type, grant types, or OIDC-specific settings.

---

## 4. Goals & Non-Goals

### 4.1 Goals

1. **Authorization Code Flow:** Implement RFC 6749 Section 4.1 compliant authorization code grant, enabling third-party applications to obtain user-scoped access tokens.
2. **PKCE Support:** Implement RFC 7636 PKCE to secure the authorization flow for public clients (SPAs, native apps) that cannot safely store client secrets.
3. **OpenID Connect id_token:** Issue id_tokens when the `openid` scope is requested, enabling iHub to serve as a full OIDC Identity Provider.
4. **OIDC Identity Provider:** Enable iHub to act as an OIDC IdP for other applications, aggregating all configured authentication methods behind a standard OIDC interface.
5. **Redirect URI Management:** Extend the OAuth client model to support registered redirect URIs with strict validation.
6. **Consent Screen:** Build a user-facing authorization screen where users can review and approve client access. Support consent memory with configurable TTL (default 30 days). Allow admin-designated "trusted" clients to skip consent for first-party apps.
7. **Refresh Tokens:** Issue refresh tokens alongside access tokens for long-lived sessions without re-authentication.
8. **Admin UI Updates:** Extend the OAuth client admin pages with fields for redirect URIs, client type, grant types, and trusted flag.
9. **Example Client Application:** Deliver a standalone example app (Node.js/Express + HTML) demonstrating the complete OAuth flow in both confidential and public client modes.
10. **Backward Compatibility:** Existing client_credentials and static API key flows must continue to work unchanged.

### 4.2 Non-Goals

- Implicit Grant (deprecated by OAuth 2.1, not needed with PKCE)
- Resource Owner Password Credentials Grant (deprecated)
- Device Authorization Grant (RFC 8628, can be added later)
- Dynamic Client Registration (RFC 7591, clients are admin-managed)
- `response_mode=fragment` for SPAs (PKCE with `response_mode=query` is sufficient and more secure; can be deferred)
- Multi-tenant OAuth (single iHub instance = single authorization server)

---

## 5. Proposed Solution

### 5.1 High-Level Flow

The OAuth 2.0 Authorization Code Flow with PKCE works as follows:

1. The client app generates a `code_verifier` (random string) and derives a `code_challenge` (SHA-256 hash).
2. The client redirects the user's browser to iHub's authorization endpoint with the `code_challenge`, `client_id`, `redirect_uri`, and requested scopes.
3. iHub checks if the user is already authenticated. If not, iHub renders the login page (local, OIDC, LDAP, NTLM, etc.).
4. After authentication, iHub checks if consent is needed (skipped for trusted clients and remembered consent). If needed, shows the consent screen.
5. The user approves. iHub generates a short-lived authorization code and redirects back to the client's `redirect_uri`.
6. The client sends the authorization code + `code_verifier` to iHub's token endpoint.
7. iHub validates the code, verifies PKCE, and issues `access_token` + `refresh_token` + `id_token` (if `openid` scope).
8. The client uses the `access_token` to call iHub APIs. The token carries the user's identity and permissions.

### 5.2 Client Types

| Client Type | Confidential? | PKCE Required? | Has Client Secret? |
|---|---|---|---|
| Server-side Web App | Yes | Recommended | Yes |
| Single Page App (SPA) | No | Required | No |
| Native/Mobile App | No | Required | No |
| CLI Tool | No | Required | No |

Confidential clients authenticate with `client_id` + `client_secret` at the token endpoint. Public clients rely solely on PKCE and do not send a `client_secret`.

### 5.3 Token Scoping

Tokens issued via the authorization code flow carry the user's identity and are scoped by the intersection of:

- **User permissions:** The authenticated user's groups, allowed apps, and allowed models (from `groups.json`)
- **Client restrictions:** The OAuth client's `allowedApps` and `allowedModels` (from `oauth-clients.json`)

Following the existing pattern, allowedApps/Models are retrieved at runtime from the client config (not baked into the token), enabling instant permission changes without token invalidation.

### 5.4 iHub as OIDC Identity Provider

With the authorization code flow and id_token support implemented, iHub becomes a fully compliant OIDC Identity Provider. Other applications that support standard OIDC authentication can point to iHub as their provider using:

- **Discovery URL:** `https://ihub.example.com/.well-known/openid-configuration`
- **Client ID + Secret:** Registered in iHub Admin under OAuth Clients
- **Redirect URI:** Configured per client in iHub Admin

The key insight is that iHub aggregates all its configured authentication backends (NTLM, LDAP, OIDC upstream, local) behind a single OIDC-compliant interface. External applications only integrate once with iHub.

---

## 6. Technical Architecture

### 6.1 New & Extended Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/oauth/authorize` | GET | Authorization endpoint — initiates flow, renders login/consent |
| `/api/oauth/authorize/decision` | POST | Consent decision — user approves or denies |
| `/api/oauth/token` | POST | Token endpoint — extended for `grant_type=authorization_code` and `refresh_token` |
| `/api/oauth/revoke` | POST | Token revocation (RFC 7009) |
| `/api/oauth/userinfo` | GET | UserInfo endpoint — returns authenticated user profile (OpenID Connect) |

### 6.2 Authorization Code Storage

Authorization codes are short-lived (10 minutes) and single-use. Stored in-memory using a Map with automatic expiration cleanup. Each record:

```json
{
  "code": "random_32_byte_hex",
  "clientId": "client_myapp_a1b2c3d4",
  "userId": "user_id",
  "user": { "id": "...", "name": "...", "email": "...", "groups": [], "permissions": {} },
  "redirectUri": "http://localhost:8080/callback",
  "scope": "openid profile email",
  "codeChallenge": "base64url_sha256_hash",
  "codeChallengeMethod": "S256",
  "nonce": "optional_nonce_for_id_token",
  "createdAt": 1708800000000,
  "expiresAt": 1708800600000,
  "used": false
}
```

### 6.3 Refresh Token Storage

Refresh tokens persist across server restarts in `contents/config/oauth-refresh-tokens.json`. Bcrypt-hashed. Periodic cleanup removes expired/revoked tokens (on startup + every 24 hours).

### 6.4 id_token (OpenID Connect)

When the `openid` scope is requested, the token response includes an `id_token` JWT containing:

```json
{
  "iss": "ihub-apps",
  "sub": "user_id",
  "aud": "client_myapp_a1b2c3d4",
  "exp": 1708803600,
  "iat": 1708800000,
  "auth_time": 1708799900,
  "nonce": "random_nonce_from_request",
  "name": "John Doe",
  "email": "john@example.com",
  "groups": ["users"]
}
```

The `id_token` is signed using the same algorithm as access tokens (RS256 or HS256, configurable in `platform.json`). RS256 is strongly recommended for OIDC IdP use cases since external applications can verify tokens using the JWKS endpoint without shared secrets.

### 6.5 Consent Screen Architecture

The consent screen is a server-rendered HTML page (not a React SPA route) for security and simplicity. It displays:

- The client application name and description
- The authenticated user's name and email
- Requested scopes in human-readable form
- Approve and Deny buttons with CSRF token

Consent can be remembered per client+user pair for a configurable period (default 30 days). Admin-designated "trusted" clients (first-party apps) skip the consent screen entirely.

### 6.6 Consent Memory

Remembered consent is stored in `contents/config/oauth-consent.json`:

```json
{
  "consents": {
    "client_myapp_a1b2c3d4:user123": {
      "clientId": "client_myapp_a1b2c3d4",
      "userId": "user123",
      "scopes": ["openid", "profile", "email"],
      "grantedAt": "2026-02-24T10:00:00Z",
      "expiresAt": "2026-03-26T10:00:00Z"
    }
  }
}
```

---

## 7. API Specification

### 7.1 Authorization Endpoint

**GET** `/api/oauth/authorize`

| Parameter | Required | Description |
|---|---|---|
| `response_type` | Yes | Must be `"code"` |
| `client_id` | Yes | The registered OAuth client ID |
| `redirect_uri` | Yes | Must match a registered redirect URI for the client |
| `scope` | No | Space-separated scopes (default: `openid profile email`) |
| `state` | Recommended | Opaque value for CSRF protection, returned unchanged |
| `code_challenge` | Conditional | PKCE challenge (required for public clients) |
| `code_challenge_method` | Conditional | Must be `"S256"` when `code_challenge` is present |
| `nonce` | No | Random value included in id_token for replay protection |

**Behavior:**

1. Validate all parameters. Return error redirect if invalid.
2. If user not authenticated: redirect to iHub login page (preserving all OAuth params as `returnUrl`). After login, user returns to `/api/oauth/authorize`.
3. If client is marked "trusted": skip consent, generate code immediately.
4. If consent was previously granted (and not expired): skip consent, generate code.
5. Otherwise: render consent screen.
6. On approval: generate authorization code, store consent if "remember" checked, redirect to `redirect_uri?code=...&state=...`
7. On denial: redirect to `redirect_uri?error=access_denied&state=...`

### 7.2 Token Endpoint (Extended)

**POST** `/api/oauth/token`

Extended to support three grant types:

#### grant_type=authorization_code

| Parameter | Required | Description |
|---|---|---|
| `grant_type` | Yes | `"authorization_code"` |
| `code` | Yes | The authorization code from the authorize endpoint |
| `redirect_uri` | Yes | Must match the `redirect_uri` used in the authorization request |
| `client_id` | Yes | The OAuth client ID |
| `client_secret` | Conditional | Required for confidential clients only |
| `code_verifier` | Conditional | PKCE verifier (required when `code_challenge` was used) |

#### grant_type=refresh_token

| Parameter | Required | Description |
|---|---|---|
| `grant_type` | Yes | `"refresh_token"` |
| `refresh_token` | Yes | The refresh token |
| `client_id` | Yes | The OAuth client ID |
| `client_secret` | Conditional | Required for confidential clients |
| `scope` | No | Must be equal to or subset of originally granted scopes |

#### Success Response (authorization_code)

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2g...",
  "scope": "openid profile email",
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

### 7.3 Token Revocation

**POST** `/api/oauth/revoke`

| Parameter | Required | Description |
|---|---|---|
| `token` | Yes | The token to revoke (access or refresh) |
| `token_type_hint` | No | `"access_token"` or `"refresh_token"` |
| `client_id` | Yes | The OAuth client ID |

### 7.4 UserInfo Endpoint

**GET** `/api/oauth/userinfo`

Requires Bearer `access_token`. Returns the user's profile (OIDC standard claims):

```json
{
  "sub": "user_id",
  "name": "John Doe",
  "email": "john@example.com",
  "groups": ["users", "authenticated"],
  "permissions": { "apps": ["chat"], "models": ["gpt-4"] }
}
```

---

## 8. Security Requirements

### 8.1 PKCE (RFC 7636)

- PKCE is **REQUIRED** for public clients (no `client_secret`)
- PKCE is **RECOMMENDED** for confidential clients
- Only `S256` method supported (`plain` is insecure and rejected)
- `code_verifier`: 43–128 chars, `[A-Z]`/`[a-z]`/`[0-9]`/`-`/`.`/`_`/`~`

### 8.2 Redirect URI Validation

- Exact string match required (no wildcards)
- Must be pre-registered in the OAuth client configuration
- `http://localhost` and `http://127.0.0.1` allowed for development
- All other redirect URIs must use HTTPS
- Fragment components (`#`) not allowed

### 8.3 Authorization Code Security

- Single-use: consumed on first token exchange attempt
- Expire after 10 minutes
- Bound to specific `client_id` and `redirect_uri`
- If reused, all tokens from that code are revoked
- Generated using `crypto.randomBytes(32)` (256-bit entropy)

### 8.4 Token Security

- Access tokens: Short-lived (default 60 min, configurable per client)
- Refresh tokens: Long-lived (30 days default), stored as bcrypt hashes
- Refresh token rotation: each refresh issues new token, invalidates old
- id_tokens: Signed with RS256 (recommended) or HS256, contain nonce for replay protection

### 8.5 CSRF & Consent Protection

- `state` parameter passed through flow and validated by client
- Consent form includes CSRF token validated server-side
- Trusted client flag only settable by admin (never by client self-registration)

---

## 9. Admin UI Changes

The existing Admin OAuth Client pages (`AdminOAuthClientEditPage.jsx` and `AdminOAuthClientsPage.jsx`) must be extended to support the new authorization code flow fields.

### 9.1 Client Edit Form — New Fields

The client creation/edit form must add the following new sections:

#### 9.1.1 Client Type Section

| Field | Type | Options | Default |
|---|---|---|---|
| Client Type | Select dropdown | "Confidential (Server-side)" / "Public (SPA/Native)" | Confidential |

When "Public" is selected, the client secret section should show an info banner: *"Public clients do not use a client secret. Security is provided by PKCE."*

#### 9.1.2 Grant Types Section

| Field | Type | Options | Default |
|---|---|---|---|
| Allowed Grant Types | Checkbox group | "Client Credentials" / "Authorization Code" / "Refresh Token" | Client Credentials checked |

When "Authorization Code" is checked, the Redirect URIs section becomes visible and required.

#### 9.1.3 Redirect URIs Section

A dynamic list input where admins can add/remove redirect URIs:

1. Text input field + "Add" button
2. Each added URI appears as a removable tag/badge (similar to existing `ResourceSelector`)
3. Validation: must be a valid URL, must use HTTPS (except localhost)
4. Minimum one URI required when Authorization Code grant is enabled

Optional: Post-Logout Redirect URIs (same UI pattern, separate field).

#### 9.1.4 Trust & Consent Section

| Field | Type | Description | Default |
|---|---|---|---|
| Trusted (First-party) | Toggle | Skip consent screen for this client | Off |
| Require Consent | Toggle | Always show consent screen (overrides remembered consent) | On |

### 9.2 Client List Page — Changes

The client list table should show additional columns:

- **Client Type badge:** "Confidential" (blue) or "Public" (orange)
- **Grant Types:** Comma-separated list of enabled grants
- **Redirect URIs count:** e.g., "2 URIs" as a clickable element showing the full list

### 9.3 Updated Form Layout

The recommended form section order for the edit page:

1. Basic Information (name, description, active toggle)
2. Client Type (confidential / public selector)
3. Grant Types (checkboxes)
4. Redirect URIs (dynamic list — visible when Authorization Code is enabled)
5. Post-Logout Redirect URIs (optional, dynamic list)
6. Trust & Consent (trusted toggle, require consent toggle)
7. Scopes (checkboxes: openid, profile, email)
8. Token Settings (expiration minutes)
9. Allowed Apps (existing ResourceSelector)
10. Allowed Models (existing ResourceSelector)

### 9.4 Validation Rules

- Public clients: PKCE information banner shown, client_secret operations hidden (no rotate/generate)
- Authorization Code grant selected: At least one redirect URI is required
- Redirect URIs: Must be valid URLs, HTTPS required (except localhost)
- Trusted flag: Only visible to admin users, cannot be set via API without admin auth

---

## 10. OIDC Identity Provider Capability

### 10.1 Vision

Once the authorization code flow with id_token support is implemented, iHub Apps functions as a **full OIDC Identity Provider (IdP)**. Any application that supports standard OIDC/OAuth2 authentication can use iHub as its login provider — just like applications use Google, Okta, or Keycloak today.

### 10.2 Architecture: Authentication Broker Pattern

iHub acts as an authentication broker that sits between external applications and the actual identity sources:

```
+------------------+     +------------------+     +--------------------+
| External App     |     | iHub Apps        |     | Identity Sources   |
| (OIDC Client)    |     | (OIDC IdP)       |     |                    |
|                  |     |                  |     | - Active Directory |
| 1. Redirect to   |---->| 2. Check session |     |   (NTLM/LDAP)     |
|    iHub /authorize|     |                  |     | - Authentik (OIDC) |
|                  |     | 3. Not logged in |---->| - Keycloak (OIDC)  |
|                  |     |    redirect to   |     | - Local users      |
|                  |     |    login page    |     |                    |
|                  |     |                  |<----| 4. Auth success    |
|                  |     | 5. Consent screen|     |                    |
| 7. Receive code  |<----| 6. Generate code |     |                    |
| 8. Exchange for  |---->|                  |     |                    |
|    tokens        |     | 9. Issue tokens  |     |                    |
| 10. id_token has |<----|    + id_token    |     |                    |
|     user identity|     |                  |     |                    |
+------------------+     +------------------+     +--------------------+
```

### 10.3 External Application Configuration

For an external application to use iHub as its OIDC provider, the admin configures:

**In iHub Admin (OAuth Clients page):**

1. Create new OAuth client with name matching the external application
2. Set client type: Confidential (for server-side apps) or Public (for SPAs)
3. Enable grant type: Authorization Code (+ Refresh Token if needed)
4. Add redirect URI(s) pointing to the external application's callback URL
5. Optionally mark as "trusted" to skip consent for first-party apps
6. Note the `client_id` and `client_secret`

**In the External Application (OIDC settings):**

```
Provider URL / Issuer:      https://ihub.example.com
Discovery URL:              https://ihub.example.com/.well-known/openid-configuration
Client ID:                  client_myapp_a1b2c3d4
Client Secret:              (from iHub admin)
Authorization Endpoint:     https://ihub.example.com/api/oauth/authorize
Token Endpoint:             https://ihub.example.com/api/oauth/token
UserInfo Endpoint:          https://ihub.example.com/api/oauth/userinfo
JWKS URI:                   https://ihub.example.com/.well-known/jwks.json
Scopes:                     openid profile email
```

### 10.4 End-to-End Flow Example

Scenario: External app "ProjectManager" uses iHub as OIDC IdP. iHub is configured with Authentik as its upstream OIDC provider.

1. User opens ProjectManager and clicks "Login"
2. ProjectManager redirects to iHub `/api/oauth/authorize?client_id=...&scope=openid+profile+email`
3. iHub sees user is not logged in, shows iHub login page
4. Login page shows available options: "Login with Authentik" (OIDC button)
5. User clicks Authentik button → redirects to Authentik → user enters credentials
6. Authentik redirects back to iHub callback → iHub creates local session
7. iHub shows consent screen (or skips if trusted): "ProjectManager wants to access your profile"
8. User approves → iHub generates auth code → redirects to ProjectManager callback
9. ProjectManager exchanges code for tokens → receives `access_token` + `id_token`
10. `id_token` contains: sub, name, email, groups → ProjectManager knows who the user is

### 10.5 Supported OIDC Features

| OIDC Feature | Support Level | Notes |
|---|---|---|
| Authorization Code Flow | Full | With PKCE support |
| id_token | Full | Standard claims + custom groups claim |
| UserInfo Endpoint | Full | Returns profile, email, groups |
| Discovery | Full | Already exists at `.well-known/openid-configuration` |
| JWKS | Full | Already exists at `.well-known/jwks.json` (RS256) |
| Token Introspection | Full | Already exists at `/api/oauth/introspect` |
| Refresh Tokens | Full | With rotation |
| Token Revocation | Full | RFC 7009 |
| Dynamic Registration | Not planned | Clients admin-managed |
| Front-Channel Logout | Not planned | Can be added later |

### 10.6 RS256 Requirement for IdP Use

For iHub to function as an OIDC IdP for external applications, RS256 (asymmetric) JWT signing is strongly recommended. This allows external applications to verify id_tokens using the public key from the JWKS endpoint without needing the shared secret. The `platform.json` setting `jwt.algorithm` should be set to `"RS256"` when using iHub as an IdP.

---

## 11. Example Client Application

### 11.1 Overview

A standalone Node.js/Express application demonstrating the complete OAuth 2.0 Authorization Code Flow with PKCE. Supports both confidential and public client modes via environment variable toggle.

### 11.2 Application Structure

```
examples/oauth-client/
├── package.json
├── server.js              # Express server handling OAuth flow
├── .env.example           # Configuration template
├── public/
│   ├── index.html         # Landing page with "Login with iHub" button
│   ├── callback.html      # Handles authorization code callback
│   ├── dashboard.html     # Shows user info + test API calls
│   └── style.css          # Simple styling
└── README.md              # Setup and usage instructions
```

### 11.3 Dual Mode Support

The example app supports both client modes via an environment variable:

```bash
# Confidential client mode (default)
CLIENT_MODE=confidential
CLIENT_SECRET=your_secret_here

# Public client mode (PKCE only)
CLIENT_MODE=public
# CLIENT_SECRET not needed
```

In confidential mode, the server exchanges the code with `client_id` + `client_secret`. In public mode, only the `code_verifier` is used (PKCE). This demonstrates both patterns for developers.

### 11.4 Features

1. **Login:** "Login with iHub Apps" button triggers PKCE-based authorization code flow
2. **Callback:** Receives authorization code, exchanges for tokens, displays result
3. **User Profile:** Fetches and displays authenticated user's profile from `/api/oauth/userinfo`
4. **id_token Display:** Decodes and displays the id_token claims (without verification, for demo)
5. **API Test Call:** Makes test call to iHub chat API using access token
6. **Token Refresh:** Demonstrates automatic token refresh when access token expires
7. **Logout:** Revokes tokens and clears session
8. **Error Handling:** Clear error messages for all failure scenarios

### 11.5 Configuration

```bash
# .env file for example OAuth client
IHUB_BASE_URL=http://localhost:3000
CLIENT_ID=client_example_app_a1b2c3d4
CLIENT_SECRET=                          # Only for confidential mode
CLIENT_MODE=confidential                # or "public"
REDIRECT_URI=http://localhost:8080/callback
PORT=8080
```

---

## 12. Database / Storage Changes

### 12.1 OAuth Client Schema Extension

New fields added to each client in `oauth-clients.json`:

```json
{
  "clientType": "confidential",
  "grantTypes": [
    "authorization_code",
    "refresh_token"
  ],
  "redirectUris": [
    "http://localhost:8080/callback"
  ],
  "postLogoutRedirectUris": [],
  "consentRequired": true,
  "trusted": false,
  "scopes": ["openid", "profile", "email"]
}
```

### 12.2 New Files

- **`contents/config/oauth-refresh-tokens.json`:** Stores bcrypt-hashed refresh tokens with metadata
- **`contents/config/oauth-consent.json`:** Stores remembered user consent per client+user pair

### 12.3 Authorization Codes

In-memory Map with TTL cleanup. Not persisted.

---

## 13. Configuration Changes

### 13.1 Platform Config Extension

```json
{
  "oauth": {
    "enabled": true,
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440,
    "authorizationCodeLifetimeSeconds": 600,
    "refreshTokenLifetimeDays": 30,
    "refreshTokenRotation": true,
    "requirePkceForPublicClients": true,
    "allowedResponseTypes": ["code"],
    "consentRememberDays": 30,
    "idTokenEnabled": true
  }
}
```

### 13.2 Migration Script

A new migration (`V00X__add_oauth_authorization_code_support.js`) will:

1. Add new OAuth configuration fields to `platform.json` with defaults
2. Add `grantTypes: ["client_credentials"]` to existing clients
3. Add `clientType: "confidential"` to existing clients
4. Add empty `redirectUris`, `postLogoutRedirectUris` to existing clients
5. Add `trusted: false` and `consentRequired: true` to existing clients
6. Create `oauth-refresh-tokens.json` and `oauth-consent.json` if missing

---

## 14. Migration & Backward Compatibility

All changes are additive. No existing functionality is modified or removed.

| Existing Feature | Impact | Notes |
|---|---|---|
| client_credentials grant | None | Continues to work exactly as before |
| Static API keys | None | Generate-token endpoint unchanged |
| Token introspection | Extended | Recognizes authorization_code tokens too |
| JWT validation middleware | Extended | New authMode: `"oauth_authorization_code"` |
| Admin client management | Extended | New fields in create/edit forms |
| Well-known discovery | Updated | `authorization_endpoint` now functional |
| Admin UI | Extended | New form sections, existing fields unchanged |

---

## 15. Testing Strategy

### 15.1 Unit Tests

- PKCE challenge/verifier generation and validation
- Authorization code generation, storage, expiration, and single-use
- Redirect URI validation (exact match, HTTPS, localhost exception)
- id_token generation with correct claims and signing
- Refresh token rotation and revocation
- Scope intersection (user permissions AND client restrictions)
- Consent memory storage and expiration

### 15.2 Integration Tests

- Full authorization code flow with PKCE (happy path)
- Flow with each auth provider (local, OIDC, LDAP, NTLM)
- Confidential client flow (with client_secret)
- Public client flow (PKCE only)
- id_token validation by external OIDC library
- Trusted client: consent skipped
- Remembered consent: consent skipped on repeat
- Error cases: invalid redirect_uri, expired code, reused code, invalid PKCE
- Backward compatibility: client_credentials still works

### 15.3 End-to-End Tests (Example App)

- Playwright tests automating full browser-based flow
- Login via local auth + consent + callback + API call
- Login via OIDC provider + consent + callback + API call
- Both confidential and public client modes
- Token refresh when access token expires
- Deny consent and verify error handling

### 15.4 OIDC IdP Interop Tests

- External OIDC client library (e.g., `passport-openidconnect`) connects to iHub
- id_token signature verification via JWKS endpoint
- UserInfo endpoint returns correct OIDC standard claims
- Discovery endpoint provides all required OIDC metadata

---

## 16. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Example app completes full flow | 100% | Automated E2E test passes |
| All auth providers work with flow | 100% | Tested: local, OIDC, LDAP, NTLM |
| External OIDC client can use iHub as IdP | 100% | Interop test with standard OIDC library |
| id_token validates with JWKS | 100% | External verification test |
| Auth code exchange latency | < 500ms | P95 latency on token endpoint |
| Zero regression on existing OAuth | 0 failures | Existing tests pass unchanged |
| Admin UI renders correctly | 100% | Visual regression + Playwright tests |

---

## 17. Timeline & Milestones

| Phase | Duration | Deliverables |
|---|---|---|
| Phase 1: Core Authorization Flow | 1 week | Authorization endpoint, consent page, code generation/exchange, PKCE |
| Phase 2: Token Management & id_token | 3–4 days | Refresh tokens, rotation, revocation, id_token generation, UserInfo |
| Phase 3: Client Schema & Migration | 2–3 days | Client model extension, migration script, consent storage |
| Phase 4: Admin UI Updates | 3–4 days | Client type, grant types, redirect URIs, trust/consent toggles |
| Phase 5: OIDC IdP Validation | 2–3 days | Well-known updates, JWKS integration, interop testing |
| Phase 6: Example Client App | 2–3 days | Dual-mode example app, README, setup guide |
| Phase 7: Testing & Security | 3–4 days | Unit, integration, E2E, security review, OIDC interop |
| Phase 8: Documentation | 1–2 days | Developer guide, API docs, IdP setup guide |

**Estimated total: 4–5 weeks**

---

## 18. Resolved Decisions

The following decisions have been made (originally listed as open questions in v1.0):

| # | Decision | Resolution |
|---|---|---|
| 1 | Remember user consent? | Yes. Consent is remembered per client+user pair with configurable TTL (default 30 days). Stored in `oauth-consent.json`. |
| 2 | Skip consent for first-party apps? | Yes. Add a "trusted" flag per client, settable by admin only. Trusted clients skip the consent screen entirely. |
| 3 | Support id_token (OpenID Connect)? | Yes. Issue id_token when `openid` scope is requested. Required for iHub to function as a full OIDC IdP. |
| 4 | Permissions after user group changes? | Follow existing pattern: allowedApps/Models are runtime-retrieved from config, not stored in the token. Changes take effect immediately. |
| 5 | Support `response_mode=fragment`? | Deferred. PKCE with `response_mode=query` is sufficient and more secure. Can be added later if needed. |
| 6 | Example app: confidential vs public? | Both. The example app supports both modes via `CLIENT_MODE` environment variable, demonstrating both patterns. |

---

## 19. Appendix

### 19.1 Sequence Diagram: Authorization Code Flow

```
Client App          Browser              iHub Server          Auth Provider
    |                  |                      |                      |
    |  1. Click Login  |                      |                      |
    |<-----------------|                      |                      |
    |  2. Generate PKCE|                      |                      |
    |  code_verifier + |                      |                      |
    |  code_challenge  |                      |                      |
    |                  | 3. Redirect to        |                      |
    |                  |    /authorize         |                      |
    |----------------->|--------------------->|                      |
    |                  |  4. Not logged in     |                      |
    |                  |     Show login page   |                      |
    |                  |<---------------------|                      |
    |                  |  5. User logs in      |                      |
    |                  |--------------------->|  6. Authenticate     |
    |                  |                      |--------------------->|
    |                  |                      |<---------------------|
    |                  |  7. Show consent      |                      |
    |                  |     (or skip if       |                      |
    |                  |      trusted)         |                      |
    |                  |<---------------------|                      |
    |                  |  8. User approves     |                      |
    |                  |--------------------->|                      |
    |                  |  9. Redirect +code    |                      |
    |<-----------------|<---------------------|                      |
    | 10. Exchange code|                      |                      |
    |    + verifier    |                      |                      |
    |-------------------------------------->|                      |
    | 11. access_token |                      |                      |
    |   + refresh_token|                      |                      |
    |   + id_token     |                      |                      |
    |<--------------------------------------|                      |
    | 12. API call with|                      |                      |
    |    access_token  |                      |                      |
    |-------------------------------------->|                      |
    |<--------------------------------------|                      |
```

### 19.2 Sequence Diagram: iHub as OIDC IdP

```
External App        Browser              iHub (IdP)           Authentik (upstream)
    |                  |                      |                      |
    |  1. User clicks  |                      |                      |
    |     "Login"      |                      |                      |
    |  2. Redirect to  |                      |                      |
    |     iHub /authorize                     |                      |
    |----------------->|--------------------->|                      |
    |                  |  3. iHub login page   |                      |
    |                  |<---------------------|                      |
    |                  |  4. User selects      |                      |
    |                  |     Authentik         |                      |
    |                  |--------------------->|  5. Redirect to      |
    |                  |                      |     Authentik        |
    |                  |<--------------------------------------------|
    |                  |  6. User logs in      |                      |
    |                  |     at Authentik      |                      |
    |                  |-------------------------------------------->|
    |                  |                      |<---------------------|
    |                  |  7. Authentik         |                      |
    |                  |     callback          |                      |
    |                  |--------------------->|  8. iHub has user    |
    |                  |  9. Consent/skip      |     session now      |
    |                  |<---------------------|                      |
    |                  | 10. Approve           |                      |
    |                  |--------------------->|                      |
    |                  | 11. Redirect +code    |                      |
    |<-----------------|<---------------------|                      |
    | 12. Exchange code|                      |                      |
    |-------------------------------------->|                      |
    | 13. tokens +     |                      |                      |
    |     id_token     |                      |                      |
    |<--------------------------------------|                      |
    | 14. External app |                      |                      |
    |     knows user   |                      |                      |
```

### 19.3 References

- RFC 6749: The OAuth 2.0 Authorization Framework
- RFC 7636: Proof Key for Code Exchange (PKCE)
- RFC 7009: OAuth 2.0 Token Revocation
- RFC 6819: OAuth 2.0 Threat Model and Security Considerations
- OpenID Connect Core 1.0
- OpenID Connect Discovery 1.0
- OAuth 2.1 Draft

### 19.4 Glossary

| Term | Definition |
|---|---|
| Authorization Code | Short-lived, single-use code exchanged for tokens |
| PKCE | Proof Key for Code Exchange — prevents code interception |
| code_verifier | Cryptographically random string generated by the client |
| code_challenge | Base64URL-encoded SHA-256 hash of the code_verifier |
| Confidential Client | Client that can securely store a client_secret (server-side app) |
| Public Client | Client that cannot store secrets (SPA, mobile app) |
| Refresh Token | Long-lived token used to obtain new access tokens without re-auth |
| id_token | JWT containing user identity claims, issued per OpenID Connect spec |
| Consent Screen | UI where users approve a client application's access request |
| OIDC IdP | OpenID Connect Identity Provider — a server that authenticates users and issues id_tokens |
| Authentication Broker | Service that aggregates multiple auth backends behind a single interface |

---

*— End of Document —*
