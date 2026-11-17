# Least-privilege service clients and outbound/secret hygiene — implementation notes

Part of the admin UI rework (epic intrafind/ihub-apps#3739, "Now" phase). Findings and IDs:
`concepts/admin-ui-review-2026-11/README.md` and `04-access-identity.md`.

## What was done

| Finding | Change | Where |
| --- | --- | --- |
| ID-B6 (decision 4, clean break) | `POST /api/admin/oauth/clients` stores `allowedApps/Models/Prompts` as sent; missing = `[]`. Never widened to `["*"]`. | `server/routes/admin/oauthClients.js` |
| ID-B6 UI | New clients start empty; machine clients need ≥ 1 app; "All (*)" warning; grant-type-aware hint and empty texts; warning when grant types change on edit. Pure rules in `oauthClientGrants.js`. | `client/src/features/admin/pages/AdminOAuthClientEditPage.jsx`, `client/src/features/admin/utils/oauthClientGrants.js` |
| S4 | `Cache-Control: no-store` on create and rotate-secret | `server/routes/admin/oauthClients.js` |
| PL-B2 (server part) | `no-store` on `GET /api/admin/backup/export`; per-file log to `debug` | `server/routes/admin/backup.js` |
| S6 (configOverrides only) | Override log keeps the path, masks secret-like values (and secret keys inside JSON values) | `server/utils/configOverrides.js`, `server/utils/secretNames.js` |
| PL-B12 (decision 14a) | SSL card always shows the whitelist + SSRF notice; SSRF card lists it read-only; startup warning | `SSLConfig.jsx`, `SsrfConfig.jsx`, `server/utils/httpConfig.js` (`hostsSsrfTrustedOnlyViaTlsWhitelist`, `warnSsrfTrustViaTlsWhitelist`), `server/startup/worker.js` |
| OB-B13 | OTLP exporters use `httpAgentOptions: () => createAgent(url)` (SSL whitelist + proxy) | `server/telemetry/exporters.js` |

## Semantics to remember

- Machine token (`client_credentials`, static key): `enhanceUserWithPermissions` builds the
  permission sets straight from the client lists, so `[]` = nothing, `["*"]` = all. This was
  already true at runtime before this change; only the POST default changed.
- Delegated token (`authorization_code`, personal key): `intersectWithClientAllowList` — `[]` or
  `["*"]` = no extra restriction.
- `isSecretName` moved to `server/utils/secretNames.js` (no imports) because `configOverrides.js`
  runs inside `configCache.js`; importing `secretRedaction.js` there pulled in `httpConfig.js`
  (import cycle, and `node-fetch` broke a jest suite). `secretRedaction.js` re-exports it.

## Open follow-ups

- ID-B15 (`SecretRevealDialog` instead of `alert()` for the rotated secret) was not in this PR.
- `POST …/generate-token` returns a static API key without `no-store` (same class as S4).
- `validateAppAccess` / `validateModelAccess` in `server/utils/oauthTokenService.js` still treat an
  empty list as "all"; they are unused, but misleading — delete or align.
- Decision 14b: split SSRF trust from the TLS whitelist with a migration.

## Tests

- Server: `adminOauthClientsLeastPrivilege.test.js`, `backup-export-hygiene.test.js`,
  `ssrf-tls-whitelist-warning.test.js`, additions to `configOverrides.test.js` and
  `telemetry-exporters.test.js`.
- Client: `tests/unit/client/admin-oauth-client-least-privilege.test.jsx`,
  `tests/unit/client/admin-ssl-ssrf-trust.test.jsx`.
