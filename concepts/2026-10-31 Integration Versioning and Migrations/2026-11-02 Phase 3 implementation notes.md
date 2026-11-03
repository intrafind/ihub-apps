# Phase 3 implementation notes — module migrations, catalog versions, channel and pins, Revert (#3091)

**Date:** 2026-11-02 · **Branch:** `claude/modest-turing-had15v-versioning-p3` · **Concept:** [README.md](README.md) §1, §5, §6, §7 · **Builds on:** [Phase 2 implementation notes](2026-11-02%20Phase%202%20implementation%20notes.md)

What phase 3 added, where it lives, the decisions taken where the concept left room, and what is
still open. User-facing documentation: `docs/integrations.md` → *Migrations* (module steps,
Revert), `docs/marketplace.md` → *Versions, channel and pins*. The marketplace side (tags, catalog
`versions`, per-version descriptors, the validator against the previous tag) is a patch series for
`intrafind/ihub-marketplace` (see the PR description).

## Code map

| File | What it does |
| --- | --- |
| `server/validators/integrationDefinitionSchema.js` | `module` step accepted: `{ "module": "migrations/<name>.js" }` (`MIGRATION_MODULE_PATTERN`); `migrationModuleFiles()` lists the files a definition's migrations name |
| `server/services/integrations/definitions/scriptModule.js` | code files a definition may carry (`declaredCodeFiles`), `checkMigrationModuleFiles` (present, no relative import), `matchesIntegrity` (moved here from `ContentInstaller`, shared by install and runner) |
| `server/services/integrations/definitions/migrationModules.js` | **new**: trust check (built-in, or `trustCode` + hash), import of the hashed bytes as a `data:` module, `up()` with a 30 s limit |
| `server/services/integrations/definitions/migrationPlanner.js` | the plan is now a generator (`planSteps`): declarative steps applied in place, a module step yielded; `planMigration` (sync, never runs code, warns `MODULE_STEP_NOT_PLANNED`) and `planMigrationAsync` (runs modules through a `runModule` callback); `applyModuleResult` enforces what a module may change |
| `server/services/integrations/definitions/DefinitionMigrationRunner.js` | `_loadModules` / `_moduleTrust` / `_runModule`; boundary backups with the definition folder and manifest entry of their version (`_boundaryPackage`); `revert()` (`_restoreOrRevert`, `mode: restore \| revert \| automatic`) |
| `server/services/integrations/definitions/migrationBackups.js` | a backup's definition folder can be written from a package (`definition.files`); `snapshotView` adds `createdBy`, `trigger` |
| `server/validators/catalogSchema.js` | `versions: [{ version, ref? }]`; `catalogItemVersionSchema` for a version descriptor |
| `server/validators/registryConfigSchema.js` | `channel: 'stable' \| 'all'` (optional, absent = stable), `pins: { '<type>:<name>': '<range>' }` |
| `server/services/marketplace/versionPolicy.js` | **new, pure**: `listedVersions`, `offeredVersion`, `versionPolicyFields`, `isUpdate` |
| `server/services/marketplace/RegistryService.js` | `fetchItemVersion` + `versionDescriptorUrl` (ref, or `?type&name&version` on the catalog URL); browse and detail carry `offeredVersion`, `availableVersions`, `channel`, `pin`; `updateRegistry` validates the merged config |
| `server/services/marketplace/ContentInstaller.js` | `install`/`update` take `{ version }` (`resolveRequestedVersion`), refuse an older update (`VERSION_NOT_NEWER`), record `codeIntegrity`; `fetchIntegrationVersionPackage` (a version's package for the boundary backups); passes `moduleTrust` and `fetchDefinitionVersion` to the runner |
| `server/services/marketplace/localContent.js`, `definitions/definitionUpdates.js`, `routes/admin/marketplace.js` | the update badge, the integrations' "Update to vX" and `GET …/updates` use the offered version |
| `server/routes/admin/integrations.js` | `POST …/installed/:id/_revert` `{ backup }` |
| `client/src/features/admin/components/integrations/InstallationBackups.jsx` | **new**: the Backups card with Revert |
| `client/src/features/admin/components/integrations/migrationState.js`, `useMigrationActions.js`, `MigrationParts.jsx` | `REVERT` action, `backupsOf`, `revertability`, the backup picker in the Restore/Revert confirmation |
| `client/src/features/admin/components/marketplace/RegistryFormDialog.jsx`, `registryPins.js` | channel select and pins editor |
| `client/src/features/admin/components/marketplace/MarketplaceItemDetail.jsx` | "Pinned to …", the offered version in the Update button/dialog, sent explicitly on update |

Tests: `server/tests/integrations/definitionVersioningPhase3.test.js` (node runner, real temp
contents: planner module steps, loader, runner trust/integrity/auth, marketplace update with
modules, version policy, revert with all four parts and a failure mid-way),
`server/tests/marketplace.versions.test.js` (Jest, real RegistryService + ContentInstaller against
a fake registry), additions to `migrationRoutes.test.js` (`_revert`) and
`definitionMigrationPlanner.test.js` (schema), client tests
`admin-integration-migrations.test.jsx` (Backups card, Revert, Restore picker),
`registry-form-dialog-versions.test.jsx`, `marketplace-update-migrations.test.jsx` (pinned update).

## Decisions taken in this phase

1. **Step shape** is the concept's: `{ "module": "migrations/1.4.0.js" }` (a string, not an
   object), restricted to `migrations/<name>.js|.mjs` so a module can never be the connector or a
   file outside that folder.
2. **"Sandbox"** = the contract, not a VM. A trusted module is server code like a `script`
   connector (Node's `vm` is no security boundary). What is enforced: the module gets copies,
   never `auth`; only `values`, `actions` and the handed binding keys are taken back; any other
   change, a returned `auth`, a throw or a timeout fails the plan; the final validation (incl. the
   `auth` comparison) still runs. Trust is the gate: built-in, or `trustCode` + hash.
3. **Hash check at run time, not only at install.** The marketplace update checks the hashes of
   the package it just fetched (`moduleTrust` from `ContentInstaller`); every later run checks the
   file on disk against `codeIntegrity` recorded in the installation manifest at install/update,
   with the registry's *current* `trustCode` (an admin who withdraws trust stops future module
   runs). The module is imported from the bytes that were hashed (`data:` URL), so there is no
   window between check and import.
4. **All modules are loaded before the first step runs.** An untrusted or changed module fails
   the run before any code executed (`globalThis` counter in the tests proves it).
5. **Revert gets its intermediate definition at update time, not at revert time.** The boundary
   backups fetch the package of each intermediate version through `versions[].ref` while the
   update runs (once per version per update). Reasons: a revert must work offline, after the
   registry dropped the version or was removed, and must restore exactly what was verified; and
   the backup then holds all four parts, so Revert is the existing restore (same lock, fencing,
   staged commit and rollback). Cost: one extra download per skipped version, only for updates
   that span several migrations. A fetch failure is logged and the backup holds no folder; Revert
   to it is then refused while another version is loaded (`REVERT_DEFINITION_MISSING`).
6. **Revert is a mode of restore** (`_restoreLocked(mode)`): `restore` keeps the phase-2 rule
   (failed / needs review only), `revert` works in every state with a named backup, `automatic`
   is the downgrade path. A built-in installation can only revert to backups of the loaded version
   (its folder belongs to the server).
7. **Channel default `stable`**, read when the field is absent; no config migration (V209 not
   used): `channel` and `pins` are optional, absent pins = no pin, and every catalog published
   today has no pre-release versions, so absent behaves as before. `codeIntegrity` in the manifest
   is new and optional; absent = a module of that definition is not trusted until the next
   update records it (no definition with module steps exists yet).
8. **Update badge = newer offered version** (semver `gt`), no longer "differs": an older catalog
   version is not an update, and `update` refuses an older version (`VERSION_NOT_NEWER`) — going
   back is Revert.
9. **Version descriptor format** (coordinated with the marketplace patches): a catalog item of
   that version, served at `versions/integrations/<folder>/<version>.json`, its `source.path`
   pointing at the exported folder `versions/integrations/<folder>/<version>/integration.json`.

## Left for later

- Backup retention (still kept forever).
- The marketplace UI offers no version picker for install (the API takes `{ version }`); the
  detail shows the offered version only.
- A pinned older version's compatibility is checked from its descriptor at install, not shown
  greyed in the browse list (the list knows the current version's compatibility only).
