# User-Specific OAuth API Keys in the Integration Section

Design note for [#2232](https://github.com/intrafind/ihub-apps/issues/2232).

## Problem

The integration section under **Settings → Integrations** lets a user connect external accounts
(Jira, cloud storage) and pick up the Outlook add-in manifest. It does not let them get credentials
for calling iHub Apps itself.

Today, anyone who wants to drive iHub from a script, an MCP client, or an OpenAI-compatible SDK has
to ask an administrator to create an OAuth client for them under **Admin → OAuth → Clients**. That
client is a service account: it has its own allow-lists of apps and models, no connection to the
person who will actually use it, and it has to be maintained by hand as that person's needs change.

The issue asks for the self-service version: a user clicks once and gets the URLs and the
credentials, with an administrator deciding whether the option is offered at all and under what
limits.

## Approach

A **personal API key** is an OAuth client that belongs to a specific user.

It is stored in the existing `contents/config/oauth-clients.json`, marked `personal: true`, and
carries an owner snapshot (`ownerUserId`, `ownerUsername`, `ownerName`, `ownerEmail`,
`ownerGroups`). Reusing the client store rather than introducing a second credential store means
rotation, suspension, cluster cache invalidation, admin visibility and audit logging all come for
free, and administrators keep one place to look for "who can call this server".

Tokens minted for such a client use a new auth mode, `oauth_personal_key`, and are treated exactly
like an authorization-code token: the subject is the user, permissions are resolved from that user's
groups on every request, an optional per-client allow-list can narrow them further, and admin access
is denied unconditionally.

### Two credentials, one key

The issue asks for "urls and api keys/client id and secret", which are two different things and both
are useful:

- The **API key** is a long-lived bearer token. It is what a user pastes into an MCP client config
  or a shell script. One click, no exchange step.
- The **client ID and secret** drive the existing `client_credentials` grant at
  `/api/oauth/token`, for callers that would rather hold a secret and mint short-lived tokens.

Both come from the same backing client, so revoking the key kills both. Administrators can turn the
second one off with `allowClientCredentials: false`, which also clears the client's `grantTypes`
so the token endpoint refuses the exchange.

### Identity is resolved, not frozen

The token carries only `sub`, `client_id`, `client_name`, `scopes` and `jti`. Display name, e-mail
and groups are read from the client record on each request.

This is what makes revocation immediate: deleting the client, suspending it, or turning the feature
off invalidates every credential ever issued for it, without waiting for expiry. It also means an
administrator editing a personal client in the admin UI changes what the key can do straight away.

The trade-off is that the owner's **group membership** is a snapshot taken at creation and refreshed
on rotation, rather than looked up live. Looking it up live is not possible for OIDC and proxy users,
whose groups only exist in the identity provider's assertion at login. The
authorization-code flow makes the same trade-off, so personal keys follow it rather than inventing a
divergent model; the bounded lifetime and the admin's ability to revoke are the mitigations, and the
documentation says so plainly.

## Administrator controls

`platform.oauth.personalKeys`, seeded by migration `V084`, all conservative:

| Field                    | Default | Purpose                                              |
| ------------------------ | ------- | ---------------------------------------------------- |
| `enabled`                | `false` | Offer the feature at all                              |
| `allowedGroups`          | `[]`    | Restrict who may create keys (empty = every user)     |
| `maxKeysPerUser`         | `5`     | Cap concurrent keys per user                          |
| `defaultExpirationDays`  | `90`    | Lifetime when the user does not choose one            |
| `maxExpirationDays`      | `365`   | Upper bound the user cannot exceed                    |
| `allowClientCredentials` | `true`  | Also issue a client ID and secret                     |
| `scopes`                 | `[]`    | Scopes per key (empty = `mcpServer.defaultScopes`)    |

The feature additionally requires `oauth.enabled.clients`, since that is the store the keys live in.
The admin page says so when the toggle is on but clients are off.

## What could go wrong, and what stops it

| Risk                                           | Mitigation                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A key grants more than its owner has           | Permissions come from the owner's groups on every request; `adminAccess` is forced to false |
| A key mints further keys                       | The management endpoints reject callers authenticated by a key or a service account         |
| An anonymous session mints a key               | Rejected explicitly, even where anonymous access is enabled platform-wide                   |
| A user enumerates or revokes somebody else's key | Ownership is checked on every operation, and a foreign key is reported as 404, not 403      |
| A rotated key keeps working                    | `lastRotated` invalidates anything issued earlier, compared at second granularity           |
| A rotation hands back the same token           | Each key carries a `jti`, so two keys minted in the same second still differ                |

## Hardening the admin gate

An end-to-end check against a running server found that a personal key belonging to an
administrator reached `/api/admin/*` and returned `200`.

`enhanceUserWithPermissions` does force `isAdmin` to false for delegated and machine principals,
but `adminAuth` and `contentAdminAuth` never consult it: they resolve admin rights from the
caller's raw group membership. Any token carrying an admin's groups therefore passed, which was
already true for OAuth service accounts and authorization-code tokens — this feature would simply
have turned it into a one-click path.

`isAdminEligiblePrincipal()` in `server/utils/authorization.js` now states the rule once, and both
middlewares consult it before looking at groups. It denies OAuth client credentials, static API
keys, authorization-code tokens, personal API keys and agent principals. Browser sessions and
non-admin APIs are untouched, which the end-to-end check confirms.

## Surface

**Server**

- `server/utils/personalApiKeyManager.js` — policy resolution, eligibility, endpoints, lifecycle
- `server/routes/integrations/personalApiKeys.js` — `/api/integrations/api-keys` (list, create,
  rotate, revoke)
- `server/utils/oauthTokenService.js` — `generatePersonalApiKey`, `isPersonalClient`, owner-bound
  `client_credentials` tokens
- `server/utils/oauthClientManager.js` — owner fields, `listPersonalClientsByOwner`,
  `updatePersonalClientOwner`
- `server/middleware/jwtAuth.js`, `server/middleware/mcpAuth.js` — the `oauth_personal_key` branch
- `server/utils/authorization.js` — personal keys resolve permissions like delegated tokens, plus
  `isAdminEligiblePrincipal`
- `server/middleware/adminAuth.js`, `server/middleware/contentAdminAuth.js` — admin gate hardening
- `server/migrations/V084__add_personal_api_key_defaults.js`

**Client**

- `client/src/features/settings/components/PersonalApiKeysCard.jsx`
- `client/src/features/settings/pages/IntegrationsPage.jsx`
- `client/src/features/admin/pages/AdminOAuthServerPage.jsx`

**Tests**

- `server/tests/personalApiKeys.test.js`, wired into `npm run test:quick`

## Known adjacent issue (not changed here)

`jwtAuth` compares `decoded.iat * 1000 < new Date(client.lastRotated).getTime()` for
`oauth_client_credentials` and `oauth_static_api_key` tokens. Because `iat` has second granularity
and `lastRotated` has millisecond granularity, a token issued in the same second as a rotation can
be rejected on its first use. The personal-key branch compares in seconds and does not have this
problem. Fixing the older branch would change auth behaviour for existing service accounts, so it is
left alone and noted here.
