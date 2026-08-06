# Migration V007 and OAuth Client Schema Extension

**Date:** 2026-02-24
**Task:** Task 2 – Migration V007 + OAuth client schema extension
**Status:** Completed

---

## What Was Done

This document describes the four files that were changed to lay the data-model
foundation for the OAuth 2.0 Authorization Code Flow feature.

---

## 1. New Migration File

**Path:** `server/migrations/V007__add_oauth_authorization_code.js`

### Purpose

Adds seven new configuration keys to the `oauth` section of `platform.json`
for every existing installation. The migration follows the project-wide
Flyway-style pattern (`version`, `description`, optional `precondition`, `up`).

### Keys Added

| Key | Type | Default | Description |
|---|---|---|---|
| `oauth.authorizationCodeEnabled` | boolean | `false` | Master switch for the authorization code grant type |
| `oauth.issuer` | string | `""` | JWT `iss` claim / OIDC discovery base URL |
| `oauth.authorizationCodeExpirationSeconds` | number | `600` | Lifetime of one-time auth codes (10 min per RFC 6749) |
| `oauth.refreshTokenEnabled` | boolean | `false` | Master switch for refresh token issuance |
| `oauth.refreshTokenExpirationDays` | number | `30` | Lifetime of refresh tokens |
| `oauth.consentRequired` | boolean | `true` | Show consent screen by default for all clients |
| `oauth.consentMemoryDays` | number | `90` | How long remembered consent is valid |

### Safety Guarantees

- `ctx.setDefault` is used for every key, so existing admin-configured values
  are never overwritten.
- All new features default to disabled / conservative values, so existing
  installations are unaffected until an admin explicitly enables them.
- The precondition guard (`ctx.fileExists('config/platform.json')`) skips
  the migration on fresh installs where `performInitialSetup` copies the
  already-updated defaults file.

---

## 2. `server/utils/oauthClientManager.js` Changes

### `createOAuthClient` – New Fields in `newClient`

Six Authorization Code Flow fields are now stored on every new client object:

```js
clientType: clientData.clientType || 'confidential',
grantTypes: clientData.grantTypes || ['client_credentials'],
redirectUris: clientData.redirectUris || [],
postLogoutRedirectUris: clientData.postLogoutRedirectUris || [],
consentRequired: clientData.consentRequired !== false,
trusted: clientData.trusted || false
```

**Field meanings:**

| Field | Values | Meaning |
|---|---|---|
| `clientType` | `'confidential'` / `'public'` | Public clients (SPAs, native apps) cannot keep a secret and must use PKCE |
| `grantTypes` | array of strings | Which OAuth grant types this client may use; defaults to `['client_credentials']` for backward compatibility |
| `redirectUris` | array of strings | Explicit allowlist of redirect URIs; empty = authorization code flow disabled |
| `postLogoutRedirectUris` | array of strings | Allowlist of URIs accepted after RP-initiated logout |
| `consentRequired` | boolean | Per-client override of the platform-level `consentRequired` default |
| `trusted` | boolean | Trusted clients skip the consent screen even when consent is required |

### `updateOAuthClient` – Extended `allowedUpdates`

The six new fields are added to the `allowedUpdates` allowlist so admins can
change them via PUT without rotating the client secret:

```js
'clientType',
'grantTypes',
'redirectUris',
'postLogoutRedirectUris',
'consentRequired',
'trusted'
```

---

## 3. `server/routes/admin/oauthClients.js` – POST Handler Changes

### Destructuring Extended

```js
const {
  name, description, scopes, allowedApps, allowedModels,
  tokenExpirationMinutes, metadata,
  clientType, grantTypes, redirectUris,
  postLogoutRedirectUris, consentRequired, trusted
} = req.body;
```

### `clientData` Object Extended

```js
clientType: clientType || 'confidential',
grantTypes: Array.isArray(grantTypes) ? grantTypes : ['client_credentials'],
redirectUris: Array.isArray(redirectUris) ? redirectUris : [],
postLogoutRedirectUris: Array.isArray(postLogoutRedirectUris) ? postLogoutRedirectUris : [],
consentRequired: consentRequired !== false,
trusted: trusted === true
```

### Response Object Extended

The 201 response now includes all six new fields so the caller sees the
persisted values (e.g., to verify defaults were applied correctly).

---

## 4. `server/defaults/config/platform.json` – New `oauth` Keys

```json
"oauth": {
  "enabled": false,
  "clientsFile": "contents/config/oauth-clients.json",
  "defaultTokenExpirationMinutes": 60,
  "maxTokenExpirationMinutes": 1440,
  "authorizationCodeEnabled": false,
  "issuer": "",
  "authorizationCodeExpirationSeconds": 600,
  "refreshTokenEnabled": false,
  "refreshTokenExpirationDays": 30,
  "consentRequired": true,
  "consentMemoryDays": 90
}
```

These defaults are used by `performInitialSetup` when creating a brand-new
installation. The migration (V007) handles the same update for existing
installations.

---

## Backward Compatibility

- All existing clients stored in `oauth-clients.json` will lack the new
  fields. Consumers must use safe fallbacks (e.g., `client.grantTypes || []`)
  when reading client records created before this change.
- The `updateOAuthClient` PUT endpoint will write the missing fields with
  their correct values the first time an existing client is saved.

---

## Junior Contributor Notes

- The migration runner tracks file checksums. **Never edit
  `V007__add_oauth_authorization_code.js` after it has been deployed.**
  To make a correction, create `V008__...` instead.
- `ctx.setDefault(obj, 'a.b.c', value)` uses dot-path notation. It creates
  intermediate objects as needed and only writes the leaf when it is absent.
- To test the migration locally, delete the relevant keys from
  `contents/config/platform.json` and restart the server; the runner will
  re-apply V007 only if it has not been recorded in
  `contents/.migration-history.json`.
