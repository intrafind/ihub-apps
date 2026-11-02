# Storage providers as installations (implementation notes)

**Date:** 2026-11-02
**Status:** Implemented on `claude/exciting-feynman-2aju98-storage` (migration V206)
**Decision:** [07 · Types and built-in configuration, section 5](07-types-and-built-in-configuration.md), issue intrafind/ihub-apps#3094
**User docs:** [docs/integrations.md → Built-in integrations](../../docs/integrations.md#built-in-integrations), [docs/apps.md → Files from storage providers](../../docs/apps.md#files-from-storage-providers), the three provider docs
**Follow-up:** [2026-11-01 Storage provider contract](2026-11-01%20Storage%20provider%20contract.md) (third-party storage providers, not implemented)

These notes are for whoever continues the work: what the product owner asked for, the model we
chose, where the code lives, the migration's rules and the open points.

## What the product owner asked for

> "Storage providers have to be individual, not one for all; they are of type storage provider;
> this allows others to implement their own provider." And: the built-ins need proper, dedicated
> configuration, shown only where configured.

Decided 2026-11-01: several installations per provider.

1. Office 365, Google Drive and Nextcloud can be installed any number of times.
2. Apps bind storage providers like any integration (one, several, or all of the type); the app
   switch `upload.cloudStorageUpload` goes.
3. The callback URL becomes base-path aware like Jira's (#3079); the `tenantIdRef` leftovers in
   the credential store are cleaned up (#3094).
4. Each provider gets its dedicated editor back (the one it had before it became an
   installation).
5. Third-party storage providers: write the contract down (see the follow-up document).

## The model in one paragraph

**The installation id is the provider id.** Before, the three definitions were singletons
(`office365`, `googledrive`, `nextcloud`) with a `providerId` install value that kept the id the
provider had in `platform.cloudStorage`. Now `singleton` and `providerId` are gone, and the
installation id is used everywhere a provider id was: the routes
(`/api/integrations/<service>/auth?providerId=<installation id>`), the callback URL
(`/api/integrations/<service>/<installation id>/callback`), the users' token files
(`contents/integrations/<service>/<userId>__<installation id>.json`), project cloud documents
(`ref.providerId`) and the Nextcloud embed plugin (`ihub_provider_id`). V206 renamed every upgraded
installation to the provider id it had, so nothing an admin registered or a user connected changed.

Why not keep `providerId` as a separate value? With several installations two ids per provider
would have to be kept unique and in sync forever, and the token files, the callbacks and the
grants would each need to know which one to use. One id is simpler and is what the users already
have.

## File map

| File | What it does |
| --- | --- |
| `server/defaults/integration-definitions/com.intrafind__{office365,google-drive,nextcloud}/` | The definitions (`type: storage`, no `singleton`, no `providerId`), `compatibility`, the `1.0.0` release entry and its notes (`releases/1.0.0/*.md`) |
| `server/services/integrations/cloudStorageConfig.js` | **Start here.** Every installation of the three definitions in the provider shape the services read (`listCloudStorageProviders`, `findCloudStorageProvider`), the grant check, `cloudStorageStatus` for `/api/auth/status` (with `definition`), the connected users per installation, `cloudStorageCallbackPath` and `resolveCloudStorageRedirectUri` (the base-path-aware derivation) |
| `server/services/integrations/OAuthIntegrationBase.js` | `_resolveRedirectUri` / `_buildCallbackUrl` delegate to `resolveCloudStorageRedirectUri`; no env vars, no localhost fallback |
| `server/services/integrations/{Office365,GoogleDrive,Nextcloud}Service.js` | Unchanged apart from the redirect call; they work per `providerId` (= installation id) as before |
| `server/routes/integrations/cloudStorageAccess.js` | Router middleware of the three route files: `providerId` required (400), unknown installation (404, not on `/status` and `/disconnect`), not granted (403); the callback path is left to the route |
| `server/services/integrations/protocols/native/connectors/cloudStorage/index.js` | The connectors: test (client, settings, redirect URI, reachability, connected users), status and connections **per installation** |
| `server/migrations/V206__storage_provider_installations.js` | The migration (below) |
| `shared/storageBindings.js` | **Pure, server and client.** Which storage providers an app binds (`type:storage`, definition id, installation id) |
| `client/src/shared/hooks/useFileUploadHandler.js` | `createUploadConfig(app, model).cloudStorage = { enabled, providers }`: the bound providers among those `/api/auth/status` lists (granted) |
| `client/src/features/chat/components/ChatInput.jsx`, `ChatInputActionsMenu.jsx`, `client/src/features/upload/components/CloudStoragePicker.jsx` | Read `uploadConfig.cloudStorage.providers`; the picker takes `providers` as a prop |
| `client/src/features/admin/components/app-form/IntegrationsConfigSection.jsx`, `storageBindingRows.js` | The **Storage providers** card of the app editor; `storageBindingRows` is the pure row builder |
| `client/src/features/admin/components/app-form/IntegrationBindingRow.jsx` | New item props `noActions`, `newBinding` (`{ required: false }` for storage), `requiredHelp` |
| `client/src/features/admin/components/integrations/editors/StorageProviderEditor.jsx`, `storageEditorModel.js` | The dedicated editor for all three definitions; the model holds what differs per provider |
| `client/src/features/admin/components/integrations/editors/InstallationEditorParts.jsx` | New `CopyableValue` (read-only value with a Copy button, announced to screen readers) |
| `client/src/features/admin/components/integrations/integrationFacts.js` | Tile facts; sources count as on unless stored as `false` |
| `server/utils/appUsageGuide.js` | The usage guide mentions cloud files when the app binds an enabled provider |
| `server/validators/appConfigSchema.js` | `upload.cloudStorageUpload` refused with a message naming the binding |
| `server/tests/integration-definition-releases.test.js` | #3092: every shipped definition a migration names has a release entry whose newest version is the definition's (allow-list `NOT_YET_RELEASED`, empty; it fails when a listed definition has its entry). This branch's own `integrations/definitionReleases.test.js` was folded into it when the people directories branch was merged in. |

## The migration V206

Order matters, so a run that stops half-way finds its work again on the next start:

1. **Rename.** Each storage installation with a `values.providerId` that differs from its id is
   renamed to it; `providerId` is dropped from all of them. Not renamed (warning: users reconnect,
   register the redirect URI of the installation id) when the target is taken by another
   installation, reserved (`jira`, `ifinder`, `workflow_…`), contains `__` or is longer than 64.
2. **Parked providers.** `config/cloudStorage.unmigrated.json` (written by V200 for a second
   provider of one type) becomes further installations: id = provider id, else
   `<type>-<provider id>` with a warning. Secrets as V200 did them; then the file is deleted
   (unknown provider types stay in it with a warning).
3. **Credentials written** (new `integration-<id>-clientSecretRef` for plain-text secrets).
4. **References first:** `groups.json` → `permissions.integrations` entries and app binding keys
   of renamed installations; apps with `upload.cloudStorageUpload.enabled: true` get
   `integrations["type:storage"] = { required: false }`, and the key is removed from every app
   (`apps/*.json` and the legacy `config/apps.json`).
5. `integrations.json` written; the unmigrated file deleted.
6. **Tenant ids.** An Office 365 installation without a tenant id gets it back from the V061
   credential `cloudstorage_<id>_tenant` (V200 tried but could never decrypt: migrations run
   before the server loads the encryption key). Then tenant id credentials are deleted when
   nothing names them — V061's `cloudstorage_*_tenant`, a parked provider's `tenantIdRef`, or a
   `secret` whose id or name mentions "tenant" and whose value equals an Office 365 tenant id. A
   credential whose value cannot be read is kept (it may be the only copy). "Names" means: any
   string value in `config/*.json`, `apps`, `tools`, `models`, `sources`, `workflows`.

Example: V200 left `{ id: "office365", values: { providerId: "o365-corp", … } }`, a group
`finance` granting `["office365"]` and `cloudStorage.unmigrated.json` with a second Nextcloud
`nextcloud-branch`. After V206: installations `o365-corp` and `nextcloud-branch`, `finance` grants
`["o365-corp"]`, the users' `erin__o365-corp.json` still matches, and the parked file is gone.

The encryption is the token storage service's, imported lazily and initialized by the migration
(`deps.crypto` replaces it in tests), as V200 does. Tests: `server/tests/migration-v206.test.js`.

**Found on the way:** V200 has the same uninitialized-key problem — its `tenantIdRef` decryption
always fell into the warning branch, and a plain-text `clientSecret` would make it throw. V200 is
applied and must not change; V206 repairs the tenant id, and the plain-text case is rare (V061
moved secrets into the store long before).

## Redirect URI

`resolveCloudStorageRedirectUri(req, provider)`: the configured `redirectUri`, else
`buildPublicBaseUrl(req)` (scheme, host, base path from trusted proxy headers) +
`/api/integrations/<service>/<id>/callback`; throws when neither exists. The editor derives the
same URL in the browser (`storageRedirectUri`: `window.location.origin` + `buildApiUrl(...)`),
which includes the runtime base path. Admins of a deployment under a base path that relied on the
old derivation (without base path) re-register the new URL or put the old one into the
installation's **Redirect URI** (breaking-changes entry).

## The app binding

`appBindsStorageProvider(app, provider)`: the app's `integrations` has the installation id, the
definition id or `type:storage`. The chat filters the providers `/api/auth/status` lists (already
granted) by the binding, and only while `upload.enabled !== false`. There is no server-side app
check on the browse routes: they are not app-scoped (the projects cloud import uses them too); the
grant is the access boundary, the binding decides what the chat offers.

A storage binding is created optional in the editor: a required one would hide the app whenever
no provider is enabled, which is rarely what an admin wants for a file picker.

## Tests

- Server: `server/tests/migration-v206.test.js`, `integrations/cloudStorageConnector.test.js` (two
  Nextcloud installations side by side, per-installation counts, redirect derivation with base
  path), `integration-access.test.js` (grants per installation, the route middleware),
  `oauth-integration-refresh.test.js`, `migration-v200.test.js` (V200 output read back after
  V206's rename), `integration-definition-releases.test.js`.
- Client: `tests/unit/client/storage-provider-bindings.test.jsx` (binding, picker filter by
  binding and grant), `admin-storage-provider-editor.test.jsx`, the Storage providers card in
  `app-editor-integrations-section.test.jsx`, facts in `integration-groups-and-facts.test.jsx`.

## Open points

- **Third-party storage providers** are designed, not built: see the contract document.
- The project cloud kinds (`office365`, `google-drive`, `nextcloud`) still pick among all granted
  installations of a provider; projects have no app binding.
- The Nextcloud embed auto-attach does not check the app's storage binding (it never checked the
  former switch either); it uses the installation the plugin announces.
- Credential ids created by V200 keep the old installation id in their name
  (`integration-office365-clientSecretRef` on the installation `o365-corp`); harmless, the
  reference is what counts.
