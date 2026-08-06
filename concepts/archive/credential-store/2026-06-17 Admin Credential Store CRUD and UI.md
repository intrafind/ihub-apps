# Admin Credential Store — CRUD route + client UI

Date: 2026-06-17
Author: coder agent
Audience: any engineer (incl. junior) continuing this work.

## Goal

Expose the central credential store (`contents/config/credentials.json`) through an
admin CRUD API and a React admin UI, and switch the existing integration UIs from
holding inline secrets to referencing a stored credential profile by `*Ref` field.

This work consumes a pre-existing foundation (schema, service, cache, encryption).
It does NOT touch the runtime runner or the backend consumers — those are owned by
other agents.

## What was built

### Server

`server/routes/admin/credentials.js` (NEW) — Express routes, `adminAuth` protected:

- `GET  /api/admin/credentials`        list all profiles (secrets redacted)
- `GET  /api/admin/credentials/:id`    one profile (secrets redacted)
- `POST /api/admin/credentials`        create (409 if id exists)
- `PUT  /api/admin/credentials/:id`    update (restores redacted secrets from disk)
- `DELETE /api/admin/credentials/:id`  delete

Key behaviors:

- Secret fields per type come from `SECRET_FIELDS_BY_TYPE` (credentialSchema.js).
- Redaction: secret → `***REDACTED***`, but `${ENV}` placeholders are preserved.
- Encryption-on-save via `tokenStorageService.encryptString()` with the
  `encryptIfNeeded` guard (skips `${ENV}` and already-`ENC[...]` values) — copied
  from `routes/admin/configs.js`.
- On PUT, a secret field submitted as `***REDACTED***` is restored from the
  existing on-disk (encrypted) value before validation, so the marker never
  reaches disk and unchanged secrets need not be retyped.
- File is read/written atomically (`atomicWriteJSON`); after every write
  `configCache.refreshCredentialsCache()` is called.
- Audit via `logAdminAction` for create/update/delete.

Registration: added to `server/routes/adminRoutes.js`
(`registerAdminCredentialsRoutes`). See "Deviation" below — the task said
`server.js`, but `server.js` only calls `registerAdminRoutes(app)`; the actual
aggregation point is `adminRoutes.js`, matching every other admin route.

Mount path: **`/api/admin/credentials`** (via `buildServerPath`).

### Client

- `client/src/api/adminApi.js` — added `listCredentials`, `getCredential`,
  `createCredential`, `updateCredential`, `deleteCredential`, and
  `parseOpenApiSpec(source)` → `POST /api/admin/tools/openapi/parse`. All added
  to the exported `adminApi` object too.

- `client/src/features/admin/components/OpenApiToolEditor.jsx` (NEW) — exports:
  - `CredentialRefSelect` (named export): the reusable credential picker. Props:
    `value`, `onChange(id)`, `types?` (filter), `label?`, `help?`, `required?`.
    Fetches `listCredentials()`, renders a `<select>` of profile ids, a refresh
    button, and a "Create new credential" link to `/admin/credentials`.
  - `OpenApiToolEditor` (default export): spec source → "Fetch & parse" →
    operation `<select>` → parameter preview → `CredentialRefSelect` auth →
    optional baseUrl/headers/hideFields/maxResponseBytes/timeoutMs. Builds a
    `type:'openapi'` tool def and calls the provided `onSave`.

- `client/src/features/admin/pages/AdminCredentialsPage.jsx` (NEW) — list +
  create/edit/delete. Type selector drives which fields render. Secret inputs are
  `type=password` showing the `***REDACTED***` placeholder when editing. Type is
  locked after creation (delete + recreate to change type).

- `client/src/features/admin/pages/AdminToolEditPage.jsx` — added an "OpenAPI"
  tab + pane shown when `toolData.type === 'openapi'`, plus a banner on the config
  tab (new tools) to switch into OpenAPI mode. The pane renders `OpenApiToolEditor`
  which saves via the existing `createTool`/`updateTool`.

- Integration UIs switched to `CredentialRefSelect` bound to `*Ref` fields:
  - `JiraConfig.jsx`: `clientSecret` → `clientSecretRef`
  - `CloudStorageConfig.jsx`: `clientSecret` → `clientSecretRef`; office365
    `tenantId` → `tenantIdRef` (state defaults, allowed-field lists, and
    validation updated accordingly)
  - `PlatformFormEditor.jsx`: OIDC `clientSecret` → `clientSecretRef`; LDAP
    `adminPassword` → `adminPasswordRef`; NTLM `domainControllerPassword` →
    `domainControllerPasswordRef`
  - `AdminMcpServersPage.jsx`: bearer `token` → `tokenRef`, basic `password` →
    `passwordRef`, oauth `clientSecret` → `clientSecretRef` (kept auth.type
    selector and non-secret fields username/clientId/tokenUrl/scope)

- Routing/nav:
  - `client/src/App.jsx`: lazy import + `<Route path="credentials" ...>` under
    `/admin`.
  - `client/src/features/admin/components/AdminSidebarNavData.js`: nav entry under
    the Integrations section (`/admin/credentials`). See "Deviation".

## Deviations from the task spec

1. **Route registration in `adminRoutes.js`, not `server.js`.** `server.js` has no
   per-route registration; it calls `registerAdminRoutes(app)`. Registering in
   `adminRoutes.js` is the established convention. `server.js` needed no change.

2. **Nav entry in `AdminSidebarNavData.js`, not `App.jsx`.** The admin sidebar is
   data-driven from `AdminSidebarNavData.js`; `App.jsx` only holds routes. Adding
   the nav item there is the only way it renders. `App.jsx` still got the route.

## Verification done

- `node --check` passes on `credentials.js` and `adminRoutes.js`.
- Full server boot and ESLint could NOT run here (node_modules not installed in
  this environment). Before merging, run:
  `npm run lint:fix && npm run format:fix` and a server smoke test.

## Follow-ups for other agents / next engineer

- Backend consumers (Jira/CloudStorage/OIDC/LDAP/NTLM/MCP/OpenAPI runner) must read
  the new `*Ref` fields via `credentialService.resolve()/resolveSecret()`.
- `/api/admin/tools/openapi/parse` is consumed by the client but implemented by the
  runner agent. Until it exists, "Fetch & parse" will error.
- A config migration may be wanted to map any legacy inline secrets onto credential
  profiles + `*Ref` fields (out of scope here).
