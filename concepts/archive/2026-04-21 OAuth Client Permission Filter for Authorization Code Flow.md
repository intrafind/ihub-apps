# OAuth Client Permission Filter for Authorization Code Flow

**Issue:** https://github.com/intrafind/ihub-apps/issues/1299
**Date:** 2026-04-21
**Status:** Implemented

## Problem

When a user authenticates through the Outlook add-in (or any other OAuth public
client using the `authorization_code` grant), the access token carries the user's
full group membership. The iHub server did not apply any filtering based on the
OAuth client that issued the token, even though the admin UI allows configuring
`allowedApps` and `allowedModels` on a per-client basis.

As a result, the Outlook add-in — which has `allowedApps: []` and
`allowedModels: []` by default — effectively gave every signed-in user access to
every resource their group permissions allowed.

This differed from the existing `client_credentials` machine-to-machine flow,
where `allowedApps`/`allowedModels` were honoured (empty list = no access).

## Goals

The reporter's requirements were:

1. Admins can restrict the resources accessible via a specific OAuth client
   (e.g. Outlook add-in → only `chat` app and `gpt-4` model), independent of
   the signed-in user's group permissions.
2. If no restriction is configured on the client, the user keeps their full
   group-granted permissions. In other words, the client allow-list is a
   *filter* on top of the user's permissions — never an expansion.
3. The filter must be applied consistently across all endpoints (app lists,
   model lists, prompt lists, direct access by ID, chat, etc.).

## Design

### Semantics

For `oauth_authorization_code` (user-delegated) tokens:

| Client allow-list | Effect |
| ----------------- | ------ |
| `undefined` / `null` / `[]` | No client-level restriction — user keeps full group permissions |
| `['*']` | Same as above (wildcard) |
| `['chat', 'analysis']` | Intersection — user only sees resources in both their group permissions *and* the client list |

For `oauth_client_credentials` (machine-to-machine) tokens the existing
behaviour is preserved: empty list = no access; the list is used directly as
the permission set because there is no underlying user.

User-delegated OAuth tokens **never** grant admin access regardless of the
user's groups.

### Data flow

1. **Admin configures** `allowedApps` / `allowedModels` / `allowedPrompts` on the
   OAuth client via the admin UI (`AdminOAuthClientEditPage.jsx`).
2. **User authenticates** via `/api/oauth/authorize` → receives a JWT with
   `authMode: 'oauth_authorization_code'` and `client_id` claim.
3. **JWT auth middleware** (`server/middleware/jwtAuth.js`) loads the OAuth
   client configuration from the cached clients file and attaches
   `clientAllowedApps` / `clientAllowedModels` / `clientAllowedPrompts` to
   `req.user`. Restrictions are looked up fresh on every request so changes in
   the admin UI take effect immediately without waiting for token refresh.
4. **`enhanceUserWithPermissions`** (`server/utils/authorization.js`) computes
   the user's group-based permissions, then intersects them with the client's
   allow-list via `applyOAuthClientFilter`.
5. **Downstream endpoints** call `configCache.getAppsForUser()` /
   `getModelsForUser()` / etc., which filter using `user.permissions.apps` /
   `user.permissions.models`. Because we mutate the permissions set in step 4,
   every endpoint automatically picks up the restriction.

### Files changed

| File | Purpose |
| ---- | ------- |
| `server/utils/authorization.js` | New `intersectWithClientAllowList` + `applyOAuthClientFilter` helpers; `enhanceUserWithPermissions` applies them for authz-code tokens and denies admin access |
| `server/middleware/jwtAuth.js` | Loads OAuth client on each authz-code request, rejects tokens for deleted/suspended clients, attaches `clientAllowed*` to the user |
| `server/utils/oauthClientManager.js` | `allowedPrompts` added to the client schema and updatable fields list |
| `server/routes/admin/oauthClients.js` | Admin endpoints accept and return `allowedPrompts` |
| `client/src/features/admin/pages/AdminOAuthClientEditPage.jsx` | New `Allowed Prompts` selector; updated empty-state hints that describe the filter semantics |
| `server/tests/oauth-authz-code-permission-filter.test.js` | Unit tests for `intersectWithClientAllowList` and `applyOAuthClientFilter` |

### Security considerations

- **Fail closed:** if the client record cannot be loaded, the request is
  rejected with `503`. A deleted or suspended client rejects the token with
  `401` / `403` respectively.
- **No admin escalation:** authorization-code tokens can never be admin even if
  the underlying user is in the `admins` group. An attacker who compromises a
  client cannot use it as a back door into admin endpoints.
- **Wildcard collapse:** a user with `apps: ['*']` is narrowed to the client's
  explicit list, not left as `['*']`. This prevents a restrictive client from
  being bypassed via a user's wildcard group.

### Non-goals

- Extending the filter to tools/workflows/skills. The existing OAuth client
  schema does not have those fields and the Outlook use case doesn't require
  them. They can be added later the same way `allowedPrompts` was added.
- Refresh-token rotation changes. Refresh tokens already re-issue a new JWT on
  each rotation, and the new JWT goes through the same middleware lookup, so
  changes to client restrictions take effect within one refresh cycle.

## Testing

Added `server/tests/oauth-authz-code-permission-filter.test.js` with 11 unit
tests covering:

- `intersectWithClientAllowList`: empty list, undefined, `['*']`, user
  wildcard + client list, partial intersection, empty intersection, null
  userAllowed.
- `applyOAuthClientFilter`: no restrictions preserved, apps+models+prompts
  intersected, resources not in user permissions dropped, wildcard collapse.

All 11 tests pass.

## Migration

No migration required. The `allowedPrompts` field defaults to `[]` on existing
clients, which the new filter correctly treats as "no restriction". Existing
Outlook add-in installations will continue to work and can be tightened in the
admin UI whenever an operator chooses to.
