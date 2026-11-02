# Phase 2 implementation notes — declarative definition migrations (#3090)

**Date:** 2026-11-02 · **Branch:** `claude/exciting-feynman-2aju98-migrations` · **Concept:** [README.md](README.md) §1, §3, §4, §6, §7

Where the server side of phase 2 lives, the decisions taken where the concept left room, and what
the next pieces (the admin UI PR, phase 3) build on. User-facing documentation:
`docs/integrations.md` → *Migrations* and *API*, `docs/marketplace.md`.

## Code map

| File | What it does |
| --- | --- |
| `server/validators/integrationDefinitionSchema.js` | `migrations[]`, the seven step schemas (`MIGRATION_STEP_SCHEMAS`), `module` refused with `MODULE_STEP_MESSAGE`, `checkReleaseMigrations` (a release names its own version, the migration exists, every migration is named), `validateDefinitionMigrations` (catalog copies), `isStrictSemver` |
| `server/validators/integrationsConfigSchema.js` | `status`, `statusReason`, `migrationLog` on an installation; `normalizeStoredInstallation` turns an invalid stored `definitionVersion` into `needsReview` instead of failing the file |
| `server/validators/catalogSchema.js` | catalog items keep `migrations` (parsed, or raw when they do not pass) |
| `server/services/integrations/definitions/migrationPlanner.js` | **pure**: `migrationsBetween`, `planMigration` (steps, collisions, warnings, boundaries, summary), `validateMigrationResult`, `installationMigrationState` |
| `server/services/integrations/definitions/migrationBackups.js` | backup folders under `contents/backups/integrations/`, manifest, staging, commit markers |
| `server/services/integrations/definitions/DefinitionMigrationRunner.js` | locks, `migrate`, `restore`, `adopt`, `applyDefinitionUpdate` (marketplace), `recoverInterruptedCommits`, `runStartup`, `describe` (admin view) |
| `server/services/integrations/definitions/migrationPreview.js` | **pure**: the marketplace update preview from a catalog item |
| `server/services/integrations/definitions/IntegrationRegistry.js` | `stageInstalled` / `commitStaged` / `restorePrevious` / `stageCopy`: a definition folder can be staged and moved in later |
| `server/storage/LockManager.js`, `providers/filesystem/FilesystemLockManager.js` | fencing token: `withLock(name, lease => …)`, `lease.isCurrent()`, `isTokenCurrent(name, token)`; counter in `locks/<digest>.fence` |
| `server/server.js` → `prepareContents()` | the startup trigger, right after the numbered config migrations |
| `server/migrations/V207__integration_definition_version_baseline.js` | stamps the version baseline on installations without a valid one |

Tests: `server/tests/integrations/definitionMigrationPlanner.test.js`, `definitionMigrationRunner.test.js`
(node test runner, real temp contents folder), `migrationRoutes.test.js` (server Jest), the lock
fencing cases in `server/storage/__tests__/providerConformance.js`, `server/tests/migration-v207.test.js`.

## Decisions taken in this phase

1. **Startup trigger runs in `prepareContents()`**, i.e. in the cluster primary (or the single
   process), after `runConfigMigrations()` and before any worker forks. That is the one place that
   runs once per cluster and before anything loads, so no worker ever serves unmigrated values and
   the crash recovery really is "before normal loading". The runner therefore reads every file
   fresh through `ConfigStore`, never through `configCache` (not initialised there), and falls back
   to a `FilesystemLockManager` over the storage base directory while no storage provider is up.
2. **Shared bindings.** The installation's own binding and the definition binding are rewritten
   (the definition's action names; steps are idempotent, so a sibling installation of the same
   definition migrating later is no collision). A `type:` binding is never rewritten; when it names
   what changed, the plan carries a `TYPE_BINDING_NOT_REWRITTEN` warning.
3. **Invalid stored `definitionVersion`** is dropped by the schema's preprocess and the
   installation gets `status: needsReview` with the value in `statusReason`; the file still loads.
   A *missing* version is derived as `needsReview` at read time.
4. **`migrationPending` is derived**, never stored (a stored one is re-derived). A pending
   installation with no migration between the versions keeps serving tools and an ordinary save is
   allowed (it stamps the version); with migrations between, it offers no tools and a save is `409
   MIGRATION_PENDING`.
5. **Commit "move into place"** writes the staged JSON through `ConfigStore.writeJson` (so a non
   filesystem storage provider keeps working), the definition folder is renamed. Restores and
   rollbacks **merge**: they put back the installation's entry, the binding keys the backup kept per
   app and the manifest entry, not whole files, so unrelated changes made since survive.
6. **Marketplace update:** an installation whose plan fails is marked `migrationFailed` in the same
   commit and the update goes in (concept §3 step 4: "Restore backup (the pre-update definition and
   values)"); a commit that fails rolls back folder, installations, apps and manifest.
7. **Final validation** additionally checks the sign-in mode against the definition's modes, and a
   `defaultScope`/`pinnedScope` against a definition that declares no `scopes` at all. Values are
   validated with the definition defaults filled in (like `effectiveValues`), never stored. Action
   names are not checked for MCP and A2A (their actions come from the server).
8. The admin view's former `status` (live connection status) is now `liveStatus`; `status` is the
   migration state (breaking-changes entry written).

## Left for later

- **Admin UI** (separate PR): pills and actions per state on the tiles and the installation page,
  the migration log, the update dialog using `migrationPreview` and `integrationMigrations`, the
  Admin → Apps warning (warnings carry `appId`). The API is documented in `docs/integrations.md`.
- **Phase 3 (#3091):** `module` steps (refused today in `migrationStepSchema`; the planner's
  `applyStep` default branch is where a module step would be dispatched), registry pin/channel,
  "Revert" (today `_restore` is offered for `migrationFailed`/`needsReview` only).
- Backups are never pruned; a retention rule is open.
- `server/integrationRegistry.js` (app requirements) treats a blocked installation like any
  enabled one, as it does for an incompatible one: the app stays listed but lacks the tools.
