# One OAuth Client for Claude: Replacing Per-User Dynamic Client Registration

**Date:** 2026-09-14
**Issue:** https://github.com/intrafind/ihub-apps/issues/2358
**Status:** Proposal
**Related:** [#1461](https://github.com/intrafind/ihub-apps/issues/1461) (MCP gateway),
`docs/mcp-integration.md`, `concepts/2026-08-28 User-Specific OAuth API Keys in the Integration Section.md`

## Problem

Since 5.5.0 the MCP gateway advertises RFC 7591 Dynamic Client Registration (DCR). Every time a
user adds iHub as a custom connector in Claude, Claude calls `POST /api/oauth/register` and iHub
creates a brand-new record in `contents/config/oauth-clients.json`. Registration is unauthenticated
by design, so the record knows nothing about the person who triggered it: `createdBy: 'dcr'`, name
taken from Claude's `client_name`, no owner.

Three things go wrong at once:

1. **The admin UI is not built for it.** Admin → OAuth → Clients is a flat list designed for a
   handful of hand-made service accounts. There is no filter, no grouping, no owner column, and every
   Claude connection adds an indistinguishable "Claude" row with the same redirect URI.
2. **It does not scale, and it fails earlier than "thousands".** `oauth.dcr.maxClients` defaults to
   100. The 101st user to connect gets `Dynamic client registration limit reached` and cannot
   connect at all. Below the cap, every registration rewrites the whole clients file, bcrypt-hashes
   a secret nobody will use, and broadcasts a cache invalidation to every cluster worker.
3. **Nobody can tell which record belongs to whom.** The only places that know the user are the
   consent store and the refresh-token store, both keyed `clientId:userId`, and neither has a UI.

The user-facing questions this document answers:

- *Should we name the clients after the user?* No — see [Option A](#a-name-dcr-clients-after-the-user).
- *Can we have one client, so we don't create a new one?* Yes, in two ways that work together:
  Claude can bring its own stable client identity (CIMD), and a Claude organisation can pin one
  pre-registered client. Both are covered below.

## Why every user gets a client (root cause)

Claude picks how to identify itself in a fixed order (Anthropic,
[Authentication for connectors](https://claude.com/docs/connectors/building/authentication)):

1. Pre-registered client credentials, if the person adding the connector entered a client ID.
2. **Client ID Metadata Documents (CIMD)** — only when the authorization server metadata advertises
   **both** `"client_id_metadata_document_supported": true` **and** `"none"` in
   `token_endpoint_auth_methods_supported`.
3. DCR — when the metadata advertises a `registration_endpoint`.
4. Ask the user for client details.

iHub advertises `none` and a `registration_endpoint` but not `client_id_metadata_document_supported`,
so Claude lands on step 3 for every fresh connection. Anthropic says so explicitly:

> DCR causes Claude to register a new client on every fresh connection, which can result in very
> large numbers of registered clients on your authorization server. CIMD and Anthropic-held
> credentials avoid the registration call entirely.

The MCP specification
([2025-11-25, Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization))
points the same way: authorization servers and clients **SHOULD** support CIMD; DCR is a **MAY**
"included for backwards compatibility with earlier versions of the MCP authorization spec".

### What CIMD is

The client's `client_id` **is an HTTPS URL** that points at a JSON document the client hosts. The
authorization server fetches it, checks that the document's `client_id` equals the URL, and takes
`client_name`, `redirect_uris`, `grant_types` and `token_endpoint_auth_method` from it. Nothing is
stored on our side; the URL is the stable identity. Claude Code's document, for reference:

```json
{
  "client_id": "https://claude.ai/oauth/claude-code-client-metadata",
  "client_name": "Claude Code",
  "client_uri": "https://claude.ai",
  "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

The hosted surfaces (claude.ai web, Desktop, mobile, Cowork) use a document on the same host and the
callback `https://claude.ai/api/mcp/auth_callback`. CIMD clients are always public clients: PKCE
(S256) proves possession of the flow, there is no shared secret.

## Options considered

### A. Name DCR clients after the user

Not possible where it would help. Registration happens before login, so at `POST /register` there is
no user. The earliest moment we know the person is the first `GET /authorize`, and stamping an owner
there still leaves N records, the 100-client cliff, the file rewrites, and a list that only becomes
readable after each user has signed in once. It also lies as soon as a second person uses the same
registration (Claude reuses a registration within an organisation in some paths). Kept only as an
attribution fallback for legacy DCR records (Phase 1 records the first user that consented, for
display).

### B. One pre-registered client per Claude organisation (works today)

Claude's custom-connector dialog has **Advanced settings** with an OAuth client ID and an optional
secret. An iHub admin creates one client — `clientType: public`, grants
`authorization_code` + `refresh_token`, redirect URI `https://claude.ai/api/mcp/auth_callback`,
the desired `mcp:*` scopes — and the Claude Team/Enterprise admin enters its client ID when adding
the connector for the organisation. Anthropic: *"a good option when you want a stable OAuth client
per organization: it avoids dynamic client registration entirely, and the credentials are scoped to
the organization that entered them."*

Every user in that organisation then shares the one client and still goes through their own sign-in
and consent, which is exactly what the consent store keys on. No code change needed; only
documentation. Limits: individual (Free/Pro) users have to paste the client ID themselves, and each
Claude organisation is one manual setup. This is the right answer for enterprise customers now and
stays valid after CIMD ships.

### C. Client ID Metadata Documents (target)

Zero configuration for the user, zero records for us, preferred by both the MCP spec and Anthropic,
and it makes the client identity stable across every user (`consentMemoryDays` finally works across
reconnects, because the `clientId:userId` key no longer changes). Requires server work — the whole
of [Design](#design) below.

### D. De-duplicate DCR registrations (stop-gap, keeps other clients working)

Claude registers as a public client (`token_endpoint_auth_method: "none"`) with identical metadata
every time. For public clients there is no secret to hand out, PKCE binds every flow, and identical
`redirect_uris` mean the returned `client_id` can only be used by the same software. Returning the
**existing** `client_id` for an identical public registration collapses thousands of "Claude" rows
into one and removes the 100-client cliff for the common case. Confidential registrations (a secret
is minted) are never de-duplicated.

Caveat: Claude Code under DCR registers its ephemeral loopback port (`http://localhost:3118/callback`)
literally, so every session is a distinct registration. Only CIMD, whose document declares
`http://localhost/callback` and is matched port-agnostically, fixes that.

### E. Anthropic-held credentials

Only available to connectors listed in Anthropic's directory and bound to exact server URLs. Not
applicable to a self-hosted iHub per customer. Dismissed.

## Recommendation

Do **C** as the target, **D** immediately as relief, document **B** for enterprise admins now, and add
a **connections model** (Design §5) that answers "who belongs to whom" regardless of how a client
identified itself. The unit administrators and users need to see is the *grant* (this user allowed
this client these scopes on this date), not the client.

## Design

### 1. Three kinds of client, one resolver

| Kind      | Where it lives                                | Examples                              |
| --------- | --------------------------------------------- | ------------------------------------- |
| `stored`  | `oauth-clients.json` (as today)               | admin service accounts, personal keys, legacy DCR |
| `cimd`    | Nowhere — resolved from the `client_id` URL   | Claude, Claude Code, VS Code, Cursor   |

Every place that does `findClientById(clientsConfig, client_id)` today — `oauthAuthorize.js`,
`oauth.js` (token, revoke, introspect, userinfo), `mcpAuth.js` — goes through one
`resolveOAuthClient(clientId, platform)` in a new `server/utils/oauthClientResolver.js`. It returns
an object with the **same shape** `createOAuthClient` produces, so nothing downstream branches on the
kind:

| Field                 | CIMD value                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `clientId`, `id`      | the URL                                                           |
| `name`                | `client_name` from the document (sanitised, ≤ 100 chars)         |
| `clientType`          | `public`                                                          |
| `grantTypes`          | document `grant_types` ∩ `[authorization_code, refresh_token]`    |
| `redirectUris`        | document `redirect_uris`                                          |
| `scopes`              | `oauth.cimd.allowedScopes` (default: DCR default list)            |
| `allowedGroups`       | `oauth.cimd.allowedGroups`                                        |
| `allowedApps/Models/Prompts` | `oauth.cimd.allowedApps/…` (default `[]` = user's own permissions) |
| `consentRequired`     | `true`, `trusted: false` — never bypassable                       |
| `tokenExpirationMinutes` | `oauth.cimd.tokenExpirationMinutes` or `defaultTokenExpirationMinutes` |
| `active`              | `oauth.cimd.enabled && hostAllowed(clientId)`                     |
| `kind`                | `'cimd'` (new; `stored` for everything else)                      |

### 2. Fetching the metadata document — `server/utils/clientIdMetadata.js`

Detection: a `client_id` is a CIMD identifier when it parses as a URL with scheme `https:`, a
non-empty path, no fragment, no username/password, ≤ 2000 characters. Anything else is a stored ID.

Order of checks, cheapest first, before any network call:

1. `oauth.cimd.enabled` and `oauth.enabled.authz`, else `invalid_client`.
2. Host trust policy: `oauth.cimd.allowedClientHosts` uses the pattern semantics of
   `services/mcp/safeFetch.js` (`hostMatchesPattern`: exact, `*.example.com`, `.example.com`).
   Default `["claude.ai"]`. An empty list means CIMD is advertised but no host is trusted; `*` opens
   it to any HTTPS client (MCP spec's "open server" posture, not recommended). Rejected hosts are
   logged and audited (`oauth.cimd.rejected`) so an admin sees what tried to connect.
3. Cache lookup (below).

Fetch rules (draft-ietf-oauth-client-id-metadata-document-00 §4 and §6, plus repo SSRF policy):
resolve through `utils/ssrfGuard.js` (`assertPublicTarget` + `createPinnedLookup`) so a public
hostname pointing at a private address is refused; `Accept: application/json`; follow **no**
redirects; 5 s timeout (`oauth.cimd.fetchTimeoutMs`); refuse bodies over 8 KB (draft recommends
5 KB — Claude's document is ~400 bytes); require `Content-Type` JSON.

Validation: `client_id` string-equal to the requested URL; `redirect_uris` a non-empty array where
every entry passes `dcrValidation.validateRedirectUri` (same policy as DCR: https, loopback http,
private-use schemes, denied schemes); `grant_types` ⊆ `[authorization_code, refresh_token]`;
`response_types` ⊆ `[code]`; `token_endpoint_auth_method` must be `none` — the draft forbids
shared-secret methods for CIMD clients and `private_key_jwt` is out of scope for v1 (a future phase
may accept `jwks_uri`). Failures return `invalid_client` and are **not** cached.

Cache: in-process `Map` keyed by exact URL, TTL from `Cache-Control: max-age` clamped to
`[300 s, oauth.cimd.cacheMaxSeconds (86400)]`; entries are served stale for up to 24 h if a refresh
fails, so a hiccup at claude.ai never breaks a user who is mid-flow. Per-worker caches are fine:
the data is derived and every worker can fetch independently (bounded by the TTL floor).

### 3. Authorization, token and gateway changes

**`GET /api/oauth/authorize`**

- URL-shaped `client_id` → resolver. Unknown/disallowed host renders a plain "This client is not
  allowed on this server" page naming the hostname, as `renderGroupDeniedPage` does for groups.
- Redirect URI matching stays exact, with one RFC 8252 §7.3 exception: when the registered URI's
  host is `localhost`, `127.0.0.1` or `[::1]` and the presented URI differs **only in port**, it
  matches. Claude Code declares `http://localhost/callback` and calls back on an ephemeral port;
  Anthropic asks servers to accept both loopback forms port-agnostically. Applied to all clients
  for consistency (stored clients with loopback URIs are dev-only today).
- PKCE S256 is already mandatory for public clients; unchanged.
- Consent is **always** shown for CIMD clients (`trusted` can never be set), and
  `mcpServer.requireConsent` keeps forcing it for `mcp:*` scopes as today.
- Consent screen: show the hostname of the `client_id` prominently next to `client_name`
  ("Claude · claude.ai") and, when every registered redirect URI is loopback, the warning the MCP
  spec asks for ("this application runs on your computer; make sure you started this request").
  The footer already prints the client ID; for a URL it should be the full URL.
- Group allowlist (`oauth.cimd.allowedGroups`) and scope filtering use the existing
  `isUserAllowedByGroups` and scope-fallback code paths through the resolved client object.

**`POST /api/oauth/token`**

- `authorization_code`: the client comes from the resolver. If the document cannot be fetched at
  this moment but the code's `clientId` equals the presented `client_id`, the exchange proceeds with
  the cached or synthetic public client — the code already binds `client_id`, `redirect_uri` and the
  PKCE verifier, which is what proves the client. The draft's "abort on fetch failure" applies to
  the *authorization* request, where we still enforce it.
- `refresh_token`: same rule; the refresh entry carries `clientId`, and refresh tokens are already
  rotated (Anthropic requires rotation for public clients).
- `aud` stays the `client_id` for now (see [Follow-ups](#follow-ups-not-in-scope)).

**`mcpAuth`**

- For URL `client_id` claims, skip the store lookup and build the client from the CIMD policy. The
  `active` check becomes "CIMD still enabled and host still allowed" — turning the toggle off or
  removing a host is an immediate kill switch for every token issued to that client, matching how
  suspending a stored client behaves today. No network fetch on the request path.
- `req._mcpToken.clientId` already carries the URL, so audit logs and usage stats attribute calls
  to "Claude (claude.ai)" without further change.

**Discovery (`wellKnown.js`)**

- Add `client_id_metadata_document_supported: true` when `oauth.cimd.enabled && oauth.enabled.authz`.
  `token_endpoint_auth_methods_supported` already lists `none`, which is the second condition Claude
  checks. Keep `registration_endpoint` whenever DCR is enabled so clients without CIMD still work.

### 4. DCR de-duplication (`oauthRegister.js`)

- On every request with `token_endpoint_auth_method: "none"`, compute
  `fingerprint = sha256(JSON of sorted redirect_uris, client_name, software_id, sorted grant_types, sorted scopes)`.
- If an **active** client with `metadata.dcr === true` and the same `metadata.fingerprint` exists,
  answer `201` with that client's `client_id` and its original `client_id_issued_at`; bump
  `metadata.registrationCount` and `metadata.lastRegisteredAt` (no cluster announce, like `lastUsed`).
- Otherwise create as today, storing the fingerprint. Confidential registrations skip the lookup —
  they receive a fresh secret and must stay distinct.
- `maxClients` counts distinct records, so the cap stops being a per-user cap.
- No automatic clean-up of existing duplicates: deleting a record invalidates that user's consent
  memory and refresh tokens (they simply reconnect), so it is an admin decision. Add an admin action
  **"Remove unused dynamic clients"** (`lastUsed` older than N days, or never used) to the clients
  page instead of a migration — this is data, not configuration.

### 5. Connections: the per-user object

A **connection** is "user U granted client C scopes S on date D". The data already exists:
`contents/data/oauth-consent.json` (`clientId:userId → scopes, grantedAt, expiresAt`) and
`contents/data/oauth-refresh-tokens.json` (`clientId, userId, expiry`). What is missing is a
service and a UI on top.

- Extend the consent entry with display snapshots so no join against the user store is needed
  (OIDC/proxy users have no local record): `clientName`, `clientHost` (`claude.ai` or `stored`),
  `clientKind`, `userName`, `userEmail`, plus `lastUsedAt` touched on refresh-token rotation
  (throttled to once per minute like `updateClientLastUsed`). Existing entries are read as-is.
- `server/services/oauth/ConnectionService.js`: `listConnectionsForUser(userId)`,
  `listConnections({ clientId, userId, host, page })`, `countByClient()`, and
  `revokeConnection(clientId, userId)` = delete the consent entry **and** every refresh token for
  the pair (`refreshTokenStore` gains `revokeRefreshTokensFor(clientId, userId)`; the file is small
  enough to scan). Outstanding access tokens live at most `tokenExpirationMinutes`; the UI says so.
- Admin API: `GET /api/admin/oauth/connections` (filters, paging),
  `DELETE /api/admin/oauth/connections/:clientId/:userId`; the client list response gains a
  `connectionCount` per client.
- User API: `GET /api/integrations/connections`, `DELETE /api/integrations/connections/:clientId`
  (own only; interactive sessions only, rejecting delegated and machine tokens exactly as the
  personal-API-key endpoints do).
- Audit (`logAudit`): `oauth.connection.granted` (on consent), `oauth.connection.revoked`
  (user or admin, with actor), `oauth.client.registered` (DCR, with `deduplicated: true|false`),
  `oauth.cimd.rejected` (host not allowed / document invalid). Names to be aligned with
  `validators/auditEntrySchema.js` when implementing.

**UI**

- Settings → Integrations: a **Connected apps** card next to Personal API keys — one row per
  connection: client name and host, granted scopes in plain language (reuse the consent-screen
  descriptions), granted date, last used, **Disconnect**.
- Admin → OAuth: a **Connections** tab (table: user, client, kind/host, scopes, granted, last used,
  revoke; filters by user and client; URL-persisted like other list pages). Admin → Users → user
  detail: the same list for that user.
- Admin → OAuth → Clients: kind badges (`admin`, `personal`, `dynamic`, `client metadata`), a kind
  filter with *dynamic* collapsed by default, a `connections` count on each row, and a synthetic
  read-only row per **seen** CIMD host ("Claude · claude.ai · 1,234 connections") built from the
  connection index — CIMD clients are not stored, but admins still need to see them.
- Admin → MCP gateway → Authentication: rename to **Client identification** with two toggles:
  *Client ID Metadata Documents (recommended)* with the trusted-hosts input, and *Dynamic client
  registration (legacy fallback)*. The connect-Claude instructions text drops the "create a client
  manually" branch when CIMD is on and gains the enterprise note from Option B.

### 6. Administrator controls — `platform.oauth.cimd` (migration `V101`)

| Field                    | Default                          | Purpose                                              |
| ------------------------ | -------------------------------- | ---------------------------------------------------- |
| `enabled`                | `false`                          | Advertise and accept URL client IDs                   |
| `allowedClientHosts`     | `["claude.ai"]`                  | Trust policy; `*` = any HTTPS client                  |
| `allowedGroups`          | `[]`                             | Who may connect such clients (empty = everyone)       |
| `allowedScopes`          | `[]`                             | Grantable scopes (empty = DCR default list)           |
| `allowedApps` / `allowedModels` / `allowedPrompts` | `[]`   | Optional narrowing on top of the user's permissions   |
| `tokenExpirationMinutes` | `oauth.defaultTokenExpirationMinutes` | Access-token lifetime for CIMD clients           |
| `cacheMaxSeconds`        | `86400`                          | Upper bound for document caching                      |
| `fetchTimeoutMs`         | `5000`                           | Metadata fetch timeout                                |

`enabled: false` by default keeps upgrade behaviour unchanged; the MCP gateway page recommends
turning it on. `platformConfigSchema.js` is `passthrough()` at the `oauth` level, so the new keys
survive an admin save; the `dcr` block is unchanged.

### 7. Rollout

| Phase | Scope | Effect |
| ----- | ----- | ------ |
| 0 | Docs: Option B for enterprise admins; warn about `maxClients` | Customers with a Claude org can go to one client today |
| 1 | DCR de-duplication, fingerprint, kind badges + filter, "remove unused dynamic clients" action, first-consenting-user stamp on legacy records | Client list collapses to one "Claude" row; cliff removed |
| 2 | CIMD: resolver, fetcher, discovery flag, loopback port rule, consent-screen hostname, `mcpAuth`, tests, `docs/mcp-integration.md`, release note | Claude stops calling `/register` altogether |
| 3 | Connections service, user + admin UI, audit events | "Who belongs to whom", self-service disconnect |
| 4 | Follow-ups below | Spec hardening |

Phases 1 and 2 are independent PRs; 3 can start in parallel with 2.

## What could go wrong, and what stops it

| Risk | Mitigation |
| ---- | ---------- |
| SSRF: an attacker submits `client_id=https://internal-host/…` | Host allowlist is checked before any fetch; DNS-pinned public-target check from `ssrfGuard`; no redirects; size and time caps |
| Impersonation via loopback redirect (any local process can bind a port) | Consent screen shows the client hostname and a loopback warning; the default allowlist only trusts `claude.ai` |
| claude.ai unreachable | Stale-cache grace for 24 h; token exchange and refresh never depend on a live fetch |
| A rogue document changes `redirect_uris` | Re-fetched only within cache bounds; every redirect URI still passes the DCR scheme policy; exact (or loopback-port-agnostic) match |
| Consent bypass | CIMD clients cannot be `trusted`; `mcpServer.requireConsent` unchanged |
| Kill switch needed | Disable CIMD or drop the host: `mcpAuth` rejects those tokens immediately |
| DCR de-dup hands a `client_id` to a different party | Only public clients with byte-identical metadata; the ID is useless without controlling the registered redirect URI and completing PKCE |
| Existing DCR users break | Their stored clients, consents and refresh tokens are untouched; pruning is a manual admin action |
| Cache poisoning | Only valid, structurally checked 2xx JSON is cached, keyed by exact URL; errors are never cached |

## Follow-ups (not in scope)

- **RFC 8707 resource indicators.** Claude sends `resource=https://your-ihub/mcp` on both requests;
  iHub ignores it and sets `aud` to the `client_id`. The MCP spec wants the gateway to verify tokens
  were issued *for it*. Accepting `resource`, checking it equals the gateway's canonical URL, and
  putting it in `aud` (keeping `client_id` as its own claim) is a small change, but it touches
  `verifyOAuthToken`'s audience handling and `userinfo`, so it gets its own PR.
- **`private_key_jwt` CIMD clients** (`jwks_uri` in the document) for confidential native clients.
- **`scope` in the 401 challenge** so Claude requests exactly `mcpServer.defaultScopes` instead of
  everything in `scopes_supported`.
- **A transactional client store.** DCR de-duplication is last-write-wins across workers like every
  other write to `oauth-clients.json`; two workers can still create two "Claude" records in the same
  instant. Acceptable — the second becomes a duplicate to prune, not a failure.

## Surface

**Server**

- `server/utils/clientIdMetadata.js` — detection, trust policy, SSRF-safe fetch, validation, cache
- `server/utils/oauthClientResolver.js` — `resolveOAuthClient` for stored and CIMD clients
- `server/routes/wellKnown.js` — `client_id_metadata_document_supported`
- `server/routes/oauthAuthorize.js` — resolver, loopback port rule, consent-screen hostname/warning
- `server/routes/oauth.js` — resolver on token/refresh/revoke/introspect/userinfo
- `server/routes/oauthRegister.js` — fingerprint + de-duplication
- `server/middleware/mcpAuth.js` — CIMD branch, kill switch
- `server/utils/refreshTokenStore.js` — `revokeRefreshTokensFor`
- `server/utils/consentStore.js` — display snapshots, `lastUsedAt`, list functions
- `server/services/oauth/ConnectionService.js`, `server/routes/admin/oauthConnections.js`,
  `server/routes/integrations/connections.js`
- `server/migrations/V101__add_oauth_cimd_defaults.js`
- Tests: `server/tests/oauth-cimd.test.js` (detection, validation, cache, SSRF refusal, loopback
  match), `server/tests/oauth-dcr-dedup.test.js`, extend `oauth-dcr-validation.test.js`

**Client**

- `client/src/features/admin/pages/AdminMcpGatewayPage.jsx` — Client identification section
- `client/src/features/admin/pages/AdminOAuthClientsPage.jsx` — badges, filter, counts, CIMD rows,
  prune action
- `client/src/features/admin/pages/AdminOAuthConnectionsPage.jsx` (+ `OAuthTabsHeader.jsx`, route
  in `App.jsx`, `KNOWN_ROUTES`, `index.html`)
- `client/src/features/settings/components/ConnectedAppsCard.jsx`, `IntegrationsPage.jsx`
- `shared/i18n/en.json`, `shared/i18n/de.json`

**Docs**

- `docs/mcp-integration.md` — CIMD section, Option B for enterprise, updated Claude checklist
- `docs/oauth-authorization-code.md` — URL client IDs, loopback matching
- `docs/releases/<next>/features.md`

## Decisions needed

1. Default trusted hosts: `["claude.ai"]` only, or also the hosts of other CIMD-capable clients
   (VS Code, Cursor) once verified? Proposal: ship `claude.ai`, let admins add.
2. Prune legacy dynamic clients automatically after Phase 1 or leave it to the admin action?
   Proposal: admin action only.
3. Whether to take the RFC 8707 audience change into Phase 2 or keep it separate. Proposal: separate.
