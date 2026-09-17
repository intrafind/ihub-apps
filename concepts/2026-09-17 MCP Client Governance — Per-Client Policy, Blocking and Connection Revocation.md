# MCP Client Governance — Per-Client Policy, Blocking and Connection Revocation

**Date:** 2026-09-17
**Status:** Proposal
**Follows:** #2358 (CIMD, DCR de-duplication, connections) · PR #2360
**Scope:** `server/utils/oauthClientResolver.js`, `server/utils/clientIdMetadata.js`,
`server/utils/oauthClientManager.js`, `server/routes/oauthAuthorize.js`, `server/routes/oauth.js`,
`server/middleware/mcpAuth.js`, `server/services/oauth/ConnectionService.js`,
`server/routes/admin/oauthClients.js`, `server/routes/admin/oauthConnections.js`,
`client/src/features/admin/pages/AdminOAuth*`, `AdminMcpGatewayPage.jsx`

---

## 1. Where we are

Since #2358, claude.ai connects to the MCP gateway as a **CIMD** client: its `client_id` is
the HTTPS URL of a metadata document it publishes, and iHub stores no record for it. The
admin Clients page shows such clients as **synthetic, read-only rows** derived from the
consent store (`listSeenCimdClients()` in `server/services/oauth/ConnectionService.js`), and
Admin → OAuth → Connections can revoke **one user's** grant for **one client**.

That is where the governance story stops. What an administrator can actually control today,
per client kind:

| Control | Stored client (admin / DCR) | CIMD client (what Claude uses) |
|---|---|---|
| Suspend / block | ✅ `active: false` | ❌ only by disabling CIMD or dropping the whole host |
| Allowed groups | ✅ `allowedGroups` | ⚠️ one global list for **all** CIMD clients |
| Allowed apps / models / prompts | ✅ per client | ⚠️ one global list for **all** CIMD clients |
| Grantable scopes | ✅ per client | ⚠️ one global list |
| Token lifetime | ✅ per client | ⚠️ one global value |
| Revoke one user's connection | ✅ | ✅ |
| Revoke **all** connections of a client | ❌ | ❌ |
| Approve a client before it may connect | ❌ | ❌ (host allowlist only) |

Four concrete problems follow.

### P1 — Host granularity is the wrong granularity

`oauth.cimd.allowedClientHosts` is the only per-client lever, and it works on **hostnames**.
Claude web, Claude Desktop, Claude Code and Cowork all publish their documents under
`claude.ai` with *different* `client_id` URLs. "Only the `claude-code` group may connect
Claude Code, and nobody may connect Claude web" is not expressible: allowing the host allows
all of them, and blocking the host blocks all of them.

### P2 — Everything CIMD shares one policy

`getCimdConfig()` (`server/utils/oauthClientResolver.js:29`) reads a single
`platform.oauth.cimd` block, and `buildCimdClient()` stamps `allowedGroups`, `allowedApps`,
`allowedModels`, `allowedPrompts`, `scopes` and `tokenExpirationMinutes` from it onto *every*
CIMD client. Narrowing Claude Code to two apps narrows every other metadata-document client
to the same two apps.

### P3 — No bulk revocation, and no way to block

`revokeConnection(clientId, userId)` is per pair. Retiring a client, or reacting to a
compromised one, means clicking every row on the Connections page — and the moment a user
re-authorizes, they are connected again, because nothing marks the client as unwelcome.
There is no `active: false` to set: a CIMD client has no record.

### P4 — Policy is enforced at consent time, not on the request path

- `oauthAuthorize.js` checks `allowedGroups` on the GET and again on the consent POST
  (`isUserAllowedByGroups`, line 119). Good.
- `oauth.js` **refresh grant** re-checks `refreshClient.active` but **not** `allowedGroups`,
  and it rebuilds the user from `tokenData.userGroups` — the group snapshot frozen into the
  refresh-token entry at first authorization (`server/routes/oauth.js:456-462`). Rotation
  re-stamps the same snapshot, so a connection keeps refreshing indefinitely.
- `mcpAuth.js` checks `client.active` but never `allowedGroups` at all.

Net effect: **removing a user from the allowed group does not end their MCP access.** Their
client keeps rotating refresh tokens with the original group list until an administrator
revokes the connection by hand. The same is true of narrowing a client's `allowedGroups`.

---

## 2. Goals

1. **Revoke** every connection of a client in one action, and have a block actually keep it
   revoked — the client must re-authenticate and re-consent, or be refused outright.
2. **Control which clients may connect at all**: an explicit allow decision per client, not
   just per host, with an optional approval gate for clients seen for the first time.
3. **Block specific clients** — by `client_id` URL, and by host pattern for a blunter cut.
4. **Per-client resource policy**: `allowedApps`, `allowedModels`, `allowedPrompts`,
   grantable `scopes`, `tokenExpirationMinutes` — the same fields stored clients already have.
5. **Per-client group policy**: "only `claude-code-users` may connect Claude Code."
6. Policy changes take effect on the **request path**, bounded by the access-token lifetime,
   not deferred to the next consent screen.

### Non-goals

- Re-reading group membership from an external IdP mid-session (see §6, "Honest limits").
- RFC 8707 resource indicators / audience binding — still open from #2358.
- Per-tool policy on the gateway (tool visibility stays derived from accessible apps, per
  `server/services/mcp/permissions.js`).
- Rate limiting or quota per client.

---

## 3. Design

### D1 — One policy record per client, in the existing client store

Add **policy-only records** to `contents/config/oauth-clients.json`, keyed by the CIMD
`client_id` URL, carrying `metadata.cimd: true` and **no secret**.

The split is the point:

- The **document** keeps supplying *identity* — `client_name`, `redirect_uris`,
  `grant_types`, `token_endpoint_auth_method`. Never the record. The "nothing stored"
  property of CIMD is about identity, and it survives untouched.
- The **record** supplies *policy* — `active`, `allowedGroups`, `allowedApps`,
  `allowedModels`, `allowedPrompts`, `scopes`, `tokenExpirationMinutes`, plus bookkeeping
  (`firstSeenAt`, `lastUsed`, `approvalState`). These are administrator decisions, and
  administrator decisions have always been stored.
- `consentRequired: true` and `trusted: false` stay **locked** for CIMD records — writable by
  no path, exactly as `buildCimdClient` guarantees today.

Why the existing store rather than a new one:

- `loadOAuthClients()` reads through `configCache`, and `saveOAuthClients()` announces a
  cluster-wide invalidation — so a block takes effect on every worker at once, with no
  restart. A `platform.json` alternative would need a restart (see `CLAUDE.md`), which is
  exactly wrong for a kill switch.
- `mcpAuth.js` already refuses `!client.active`; `oauthAuthorize.js` already refuses on
  `allowedGroups`; `authorization.js` already intersects `clientAllowedApps` into the user's
  permissions (`intersectWithClientAllowList`, line 496). Blocking and per-client policy
  become *data* in paths that already enforce them, not new enforcement code.
- The admin Clients page and the client edit page already render these fields.

Two mechanical consequences, both real work:

- `createOAuthClient()` always mints a UUID client id and a bcrypt secret, so CIMD records
  need their own writer: `upsertCimdClientPolicy(clientId, patch, savedBy)` in
  `oauthClientManager.js`, which writes a secretless record under the exact URL key and
  refuses to touch `trusted` / `consentRequired` / `clientSecret`.
- Admin routes gate `:clientId` with `validateIdForPath()`, which rejects URL ids. The
  policy endpoints take the client id **base64url-encoded** in the path (and the raw value in
  the body for writes), the way `oauthConnections.js` already sidesteps the validator by
  decoding a store key rather than building a file path.

### D2 — Effective policy is layered, and the resolver stays the single source of truth

```
effective(field) = record[field]  when the record defines it
                 = platform.oauth.cimd[field]   otherwise
```

Field-by-field, not object-level: an administrator who set a global `allowedApps` and then
narrows `allowedGroups` on one client keeps the global apps list on that client. Both
`resolveOAuthClient()` (authorize path, may fetch) and `buildPolicyCimdClient()` (request and
token paths, never fetches) apply the same layering, so the gateway and the authorize
endpoint can never disagree. Downstream code still must not branch on `kind` — the resolver
returns one shape, as #2358 established.

`active` is the exception and is computed, not merely read:

```
active = cimd.enabled
      && hostAllowed(clientId, cimd.allowedClientHosts)
      && !hostBlocked(clientId, cimd.blockedClientHosts)
      && record.active !== false
      && approvalSatisfied(record, cimd.approvalMode)
```

Every one of those five is re-evaluated on every request, which is what makes each of them a
kill switch rather than a gate that only new connections pass.

### D3 — Blocking

- **Per client**: `active: false` on the record. The Clients page gets a Block / Unblock
  action; blocking also revokes that client's connections (D4), because a block that leaves
  live refresh tokens in place is not a block.
- **Per host**: new `oauth.cimd.blockedClientHosts`, evaluated **before** the allowlist and
  before any network call, with the same `hostMatchesPattern` semantics as
  `allowedClientHosts`. This is how you cut off a whole vendor without editing the allowlist
  you want to keep.
- A blocked client at the authorize endpoint gets the existing plain-HTML refusal page
  (sibling of `renderGroupDeniedPage`), naming the client and saying to contact an
  administrator. On `/mcp` it is `401 invalid_client`, unchanged in shape from a suspended
  stored client.

### D4 — Bulk revocation

- `ConnectionService.revokeConnectionsForClient(clientId)` — revoke every consent and every
  refresh token for the client, returning `{ connectionsRevoked, refreshTokensRevoked }`.
  Built on the existing `revokeConnection`, so there is one definition of what revoking means.
- `DELETE /api/admin/oauth/clients/:encodedClientId/connections` (adminAuth, `logAudit`).
- UI: **Revoke all connections** on the client row and on the Connections page while it is
  filtered to a single client; a confirm dialog that states the count and repeats the caveat
  the single revoke already carries — access tokens already issued are stateless and expire
  within the client's `tokenExpirationMinutes`.
- Blocking triggers it automatically; the dialog says so.

### D5 — Approval mode: controlling *which* clients may connect

New `oauth.cimd.approvalMode`:

- **`auto`** (default — today's behaviour): a client from an allowed, non-blocked host
  connects immediately. The first successful authorization writes a discovery record
  (`approvalState: 'auto'`, `firstSeenAt`, `firstUserId`) so the client becomes a real,
  editable row instead of a synthetic one.
- **`approval`**: the first authorization writes the record with
  `approvalState: 'pending'`, `active: false`, and refuses with a "waiting for administrator
  approval" page. An admin approves on the Clients page; nothing else changes.

Default `auto` because `approval` on upgrade would lock out every user already connected —
the migration must be invisible. An admin who wants a strict allowlist sets `approval` and
approves the clients they want; from then on, a new Claude surface or a new vendor cannot
connect without a decision.

### D6 — Enforce on the request path

- **Shared helper.** Move `isUserAllowedByGroups` out of `oauthAuthorize.js` into
  `server/utils/oauthClientPolicy.js` (alongside the layering from D2) so authorize, token
  refresh and `mcpAuth` share one implementation.
- **`mcpAuth.js`**: after resolving the client, run the group check against the token's
  groups and refuse with `403 access_denied` when the client's *current* `allowedGroups` no
  longer admits them. This closes the policy half of P4 immediately: narrowing a client's
  groups kills live tokens within one access-token lifetime.
- **`oauth.js` refresh grant**: run the same check against `tokenData.userGroups` and refuse
  with `invalid_grant` ("client policy no longer permits this connection"). Also intersect
  the stored `scopes` with the client's current grantable scopes and drop what is no longer
  allowed, so narrowing `allowedScopes` narrows live connections rather than only future ones.
- For **local** users, the refresh path additionally re-reads live group membership from the
  user store and refreshes the snapshot. For OIDC/proxy users, whose groups arrive from the
  IdP at sign-in, the snapshot stands (see below).

### Honest limits, to be documented rather than papered over

| Change | Takes effect |
|---|---|
| Client blocked / deleted / CIMD disabled / host removed | Next `/mcp` request — at most one access-token lifetime |
| Client `allowedGroups`, `allowedApps`, scopes narrowed | Next `/mcp` request — at most one access-token lifetime |
| Admin revokes a connection | Next refresh; existing access token lives out its lifetime |
| **Local** user leaves a group | Next refresh (snapshot re-read) |
| **OIDC/proxy** user leaves a group | Next interactive sign-in, or when an admin revokes the connection |

The last row is the residual risk and it is inherent: iHub does not hold the IdP's group
graph and cannot poll it. The mitigations are the ones above — an admin can revoke, and
`refreshTokenExpirationDays` (default 30) bounds it. Shortening that default is out of scope
here but worth a follow-up.

### D7 — Admin UI

- **Admin → OAuth → Clients**: CIMD rows become real rows with a `Client metadata` kind badge,
  the document URL, connection count, first seen, last used, and actions
  Edit policy / Block / Unblock / Revoke all connections / Approve (when pending). Pending
  rows sort first with a distinct badge.
- **Client edit page**: for a CIMD client, identity fields (name, redirect URIs, grant types,
  secret rotation) are read-only with a note that they come from the document at `<url>`;
  only the policy fields are editable. `trusted` and `consentRequired` are not rendered —
  they are locked by definition.
- **Admin → MCP gateway → Client identification**: approval-mode selector (*Connect
  automatically* / *Require approval*) and a blocked-hosts input beside the trusted-hosts one.
- i18n keys in `shared/i18n/en.json` and `de.json`, as ever.

### D8 — Audit

New `logAudit` events, aligned with `server/validators/auditEntrySchema.js`:
`oauth.client.discovered`, `oauth.client.approved`, `oauth.client.blocked`,
`oauth.client.unblocked`, `oauth.client.policyUpdated`, and `oauth.connection.revokedBulk`
(with the client and the count).

---

## 4. Alternatives considered

**Per-client policy in `platform.json` (`oauth.cimd.clients[]`).** Rejected: platform changes
need a server restart, so blocking would not be immediate — the one property a block must
have. It also splits client administration across two unrelated admin surfaces.

**A new `contents/config/oauth-client-policies.json`.** Rejected: a second store that must be
joined to the first on every resolve, with its own migration, loader, cache key and admin
page, to hold fields the first store already defines. The only argument for it is purity
about "CIMD stores nothing", and that purity is about identity, which D1 preserves.

**Materialising a full client record on first sight (name, redirect URIs and all).** Rejected:
it re-creates the DCR sprawl #2358 removed, and a stale copy of `redirect_uris` would silently
diverge from the document — the failure mode being a broken login for everyone the day the
vendor adds a callback URL.

**Blocking by revoking consents only.** Rejected: it lasts until the user clicks "connect"
again, which for a client that re-authorizes automatically is measured in seconds.

---

## 5. Implementation phases

Three independent PRs; Phase 1 delivers the operational ask on its own.

**Phase 1 — Revocation and blocking.** `revokeConnectionsForClient`, the bulk-revoke admin
endpoint, `upsertCimdClientPolicy`, discovery records on first authorization,
`blockedClientHosts`, `active` layered into `resolveOAuthClient`/`buildPolicyCimdClient`,
Block/Unblock/Revoke-all in the Clients page, the blocked-client refusal page, migration V110,
audit events, tests, docs, release note.

**Phase 2 — Per-client policy and request-path enforcement.** Field-by-field layering for
`allowedGroups` / `allowedApps` / `allowedModels` / `allowedPrompts` / `scopes` /
`tokenExpirationMinutes`; `utils/oauthClientPolicy.js`; group + scope re-checks in `mcpAuth`
and the refresh grant; live group re-read for local users; the CIMD variant of the client edit
page.

**Phase 3 — Approval mode.** `approvalMode`, pending records, the approval page and the
Approve action, the gateway-page selector, the documented operator workflow.

## 6. Acceptance criteria

See the tracking issue. In short: a blocked client's live tokens stop working on the next
`/mcp` request and its users must re-authenticate; per-client `allowedGroups` lets Claude Code
be restricted to one group while another CIMD client on the same host is unaffected; per-client
`allowedApps` narrows what that client sees without touching any other client; "revoke all"
clears every consent and refresh token for one client in one action; and with
`approvalMode: 'approval'` a never-seen client cannot connect until an administrator approves
it — while an upgrade with the defaults changes nothing for anyone already connected.

## 7. References

- #2358 — CIMD, DCR de-duplication, connections (PR #2360)
- #1461 — MCP gateway origin
- `docs/mcp-integration.md` §Client ID Metadata Documents (CIMD)
- `docs/oauth-authorization-code.md` §URL client IDs
- OAuth Client ID Metadata Document draft:
  https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
- MCP specification 2025-11-25, *Authorization*:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
