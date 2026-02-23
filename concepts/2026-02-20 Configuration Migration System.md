# Configuration Migration System — Concept & PRD

**Date:** 2026-02-20
**Author:** Daniel / Claude
**Status:** Draft — Awaiting Review

---

## 1. Problem Statement

iHub Apps uses a JSON-based configuration system where defaults are shipped in `server/defaults/` and copied to `contents/` on first run. Over time, as features evolve, configuration schemas change: keys are renamed, removed, restructured, or new required fields are introduced. Today there is no systematic way to migrate existing user configurations to match new schema expectations.

### What Happens Today

1. **New files** are handled well — `copyDefaultConfiguration()` copies any missing file from defaults to contents.
2. **New keys within existing files** are not handled. If `platform.json` gains a new section, existing installations never receive it.
3. **Renamed or removed keys** are never cleaned up. Stale configuration accumulates silently.
4. **Structural changes** (e.g., moving from a flat array to individual files) require ad-hoc migration scripts like `providerMigration.js`, which are one-off, unversioned, and re-execute every startup with no history tracking.
5. **No audit trail** — there is no record of which transformations have been applied to a given installation's configuration.

### Real-World Pain Points

- The `ensureDefaultProviders()` migration runs on every single startup, doing redundant work because there is no history to check.
- Config files like `users.json`, `groups.json`, and `oauth-clients.json` already carry `version` fields, but nothing reads or acts on them.
- When a developer adds a new feature requiring config changes, they have no established pattern for ensuring existing installations pick up the change. Documentation says "requires server restart" but even that doesn't help with schema evolution.

---

## 2. Prior Art: How Flyway & Liquibase Solve This for Databases

Both Flyway and Liquibase solve the identical problem for database schemas. Their core patterns are directly applicable to JSON configuration files.

### Flyway's Model (Primary Inspiration)

Flyway uses a file-based, convention-over-configuration approach:

**Versioned migrations** execute exactly once, in order. Named `V<version>__<description>.js`:
- `V001__initial_baseline.js`
- `V002__add_oidc_defaults.js`
- `V003__rename_allowAnonymous_to_anonymousAuth.js`

**A schema history table** (`flyway_schema_history`) records every applied migration with its version, checksum, timestamp, and success status. On startup, Flyway compares the filesystem against the history to determine which migrations are pending.

**Baseline** — for existing installations that predate the migration system, a baseline entry is created in the history table so that all pre-existing migrations are marked as "already applied."

**Checksums** detect if a previously-applied migration file was modified after the fact, preventing silent inconsistency.

**Repair** — a command to reconcile the history when things go wrong (failed migrations, modified files).

### Liquibase's Additions (Secondary Inspiration)

Liquibase adds two concepts worth borrowing:

**Preconditions** — a migration can declare conditions that must be true before it runs (e.g., "only run if key X exists in platform.json"). This makes migrations safer across heterogeneous deployments.

**Contexts / Labels** — migrations can be tagged for specific environments (e.g., "only run in Docker deployments" or "only for OIDC-enabled installations").

---

## 3. Proposed Solution: Config Migration Runner

A lightweight migration runner that executes at server startup, between `performInitialSetup()` and `configCache.initialize()`. It follows Flyway's versioned-migration model adapted for JSON file transformations.

### 3.1 Design Principles

1. **Zero-downtime adoption.** Existing installations get a baseline entry automatically. No manual intervention required.
2. **Migrations are code, not data.** Each migration is a JavaScript module with an `up()` function that programmatically transforms configuration files. This is more powerful than declarative JSON patches because real migrations often need conditional logic.
3. **Run once, tracked forever.** Each versioned migration executes exactly once. A history file records what ran and when.
4. **Fail-safe.** If a migration fails, the server logs the error clearly and can either halt startup or continue in degraded mode (configurable). The failed migration is recorded so it can be retried after a fix.
5. **Developer-friendly.** Adding a new migration should be as simple as creating a single file in the right directory with the right naming convention.

### 3.2 Architecture Overview

```
Current Startup Sequence
────────────────────────
1. dotenv.config()
2. performInitialSetup()              ← copies missing default files
3. loadJson('config/platform.json')
4. initTelemetry()
5. logVersionInfo()
6. initializeEncryptionKey()
7. initializeJwtSecret()
8. ensureDefaultProviders()           ← ad-hoc, unversioned, runs every time
9. configCache.initialize()
10. setupMiddleware()
11. registerRoutes()
12. server.listen()

Proposed Startup Sequence
─────────────────────────
1. dotenv.config()
2. performInitialSetup()              ← copies missing default files
3. ★ runConfigMigrations()            ← NEW: apply pending versioned migrations
4. loadJson('config/platform.json')
5. initTelemetry()
6. logVersionInfo()
7. initializeEncryptionKey()
8. initializeJwtSecret()
9. configCache.initialize()           ← ensureDefaultProviders() removed,
10. setupMiddleware()                    replaced by migration V002
11. registerRoutes()
12. server.listen()
```

### 3.3 File Structure

```
server/
├── migrations/
│   ├── runner.js                    # Migration engine
│   ├── utils.js                     # Helper functions for common operations
│   ├── V001__baseline.js            # Baseline: marks current state as v1
│   ├── V002__migrate_providers.js   # Replaces providerMigration.js
│   ├── V003__add_feature_flags.js   # Example: add new feature defaults
│   └── ...
contents/
├── .migration-history.json          # Tracks applied migrations
├── config/
│   ├── platform.json
│   └── ...
```

### 3.4 Migration History File

Located at `contents/.migration-history.json`. This is the equivalent of Flyway's `flyway_schema_history` table.

```json
{
  "schemaVersion": "1.0",
  "migrations": [
    {
      "version": "001",
      "description": "baseline",
      "file": "V001__baseline.js",
      "checksum": "a3f8c2e1b4d7...",
      "appliedAt": "2026-02-20T14:30:00.000Z",
      "executionTimeMs": 12,
      "status": "success"
    },
    {
      "version": "002",
      "description": "migrate_providers",
      "file": "V002__migrate_providers.js",
      "checksum": "b7e2d4f1a9c3...",
      "appliedAt": "2026-02-20T14:30:00.015Z",
      "executionTimeMs": 45,
      "status": "success"
    }
  ]
}
```

**Fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `version` | string | Unique, sortable version identifier (zero-padded number) |
| `description` | string | Human-readable name extracted from filename |
| `file` | string | Migration filename for traceability |
| `checksum` | string | SHA-256 hash of migration file contents at time of execution |
| `appliedAt` | string | ISO 8601 timestamp |
| `executionTimeMs` | number | Execution duration for diagnostics |
| `status` | string | `"success"` or `"failed"` |
| `error` | string? | Error message if status is `"failed"` |

### 3.5 Migration File Format

Each migration is a JavaScript ES module exporting a standard interface.

```javascript
// server/migrations/V002__migrate_providers.js

export const version = '002';
export const description = 'Migrate providers to include new defaults';

/**
 * Optional preconditions. Return true to proceed, false to skip.
 * @param {MigrationContext} ctx
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return ctx.fileExists('config/providers.json');
}

/**
 * Apply the migration.
 * @param {MigrationContext} ctx
 */
export async function up(ctx) {
  const providers = await ctx.readJson('config/providers.json');
  const defaults = await ctx.readDefaultJson('config/providers.json');

  const existingIds = new Set(providers.providers.map(p => p.id));
  const missing = defaults.providers.filter(p => !existingIds.has(p.id));

  if (missing.length > 0) {
    providers.providers.push(...missing);
    await ctx.writeJson('config/providers.json', providers);
    ctx.log(`Added ${missing.length} missing provider(s)`);
  } else {
    ctx.log('All default providers already present');
  }
}
```

### 3.6 Migration Context API

The `MigrationContext` object is passed to every migration's `precondition()` and `up()` functions. It provides safe, scoped access to configuration files.

```typescript
interface MigrationContext {
  // File operations (paths relative to contents/)
  readJson(relativePath: string): Promise<object>;
  writeJson(relativePath: string, data: object): Promise<void>;
  fileExists(relativePath: string): Promise<boolean>;
  deleteFile(relativePath: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  listFiles(directory: string, pattern?: string): Promise<string[]>;

  // Access defaults (paths relative to server/defaults/)
  readDefaultJson(relativePath: string): Promise<object>;

  // JSON manipulation helpers
  setDefault(obj: object, path: string, value: any): boolean;
  removeKey(obj: object, path: string): boolean;
  renameKey(obj: object, oldPath: string, newPath: string): boolean;
  mergeDefaults(obj: object, defaults: object): object;

  // Logging (prefixed with migration version)
  log(message: string): void;
  warn(message: string): void;

  // Metadata
  version: string;
  description: string;
  contentsDir: string;
  defaultsDir: string;
}
```

### 3.7 Migration Runner Logic

The runner implements the same resolution algorithm as Flyway:

```
                    ┌─────────────────┐
                    │   Server Start  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Load history   │
                    │  from .json     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Scan migration │
                    │  files on disk  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Validate      │──── Checksum mismatch? ──► Log error,
                    │   integrity     │     File missing?          halt or warn
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Resolve pending│
                    │  migrations     │
                    └────────┬────────┘
                             │
                    ┌────────▼─────────────┐
                    │  For each pending:    │
                    │  1. Check precondition│
                    │  2. Execute up()      │
                    │  3. Record in history │
                    └────────┬─────────────┘
                             │
                    ┌────────▼────────┐
                    │  Done. Continue │
                    │  server startup │
                    └─────────────────┘
```

**Resolution rules:**

1. **Scan disk:** Find all `V<version>__<description>.js` files in `server/migrations/`, sorted by version.
2. **Load history:** Read `contents/.migration-history.json` (create empty if missing).
3. **Validate applied migrations:**
   - If a history entry has `status: "failed"`, log a warning. The runner can be configured to either retry the failed migration or halt.
   - If a migration file's checksum differs from its history entry, log a validation warning. In strict mode, halt. In lenient mode (default for initial rollout), warn and continue.
4. **Determine pending:** Any migration on disk whose version is not in the history (or was previously failed and retry is enabled).
5. **Execute in order:** Run pending migrations sequentially, lowest version first.
6. **Record results:** Write success/failure to history after each migration.

### 3.8 Baseline Strategy

For existing installations that already have a `contents/` directory with configuration but no `.migration-history.json`:

1. The runner detects that `contents/` has config files but no history file.
2. It creates a history file with a single baseline entry for `V001__baseline.js`.
3. All migrations with version > 001 are treated as pending and executed.

The baseline migration itself (`V001__baseline.js`) is a no-op — its purpose is simply to establish a starting point in the history.

```javascript
// server/migrations/V001__baseline.js
export const version = '001';
export const description = 'baseline';

export async function up(ctx) {
  ctx.log('Baseline established for existing installation');
  // No-op: marks the starting point for migration tracking
}
```

**For brand-new installations** (fresh `contents/` just copied from defaults), all migrations including V001 run in sequence. Since V001 is a no-op, this is harmless. Subsequent migrations apply any transformations needed beyond the defaults.

### 3.9 Preconditions

Migrations can optionally export a `precondition()` function. If it returns `false`, the migration is skipped and recorded as `status: "skipped"` in the history. This prevents migrations from failing on installations where they don't apply.

Common use cases:
- Skip OIDC-related migrations if OIDC is not configured.
- Skip migrations for features that aren't enabled.
- Skip migrations if the target file doesn't exist (e.g., a custom config that not all installations have).

```javascript
export async function precondition(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  return platform.oidcAuth?.enabled === true;
}
```

### 3.10 Error Handling & Recovery

**When a migration fails:**

1. The error is caught and recorded in the history with `status: "failed"` and the error message.
2. The runner logs a clear error with the migration version, description, and stack trace.
3. Based on configuration (`platform.json` → `migrations.onFailure`):
   - `"halt"` (default): Server startup is aborted. The administrator must fix the issue and restart.
   - `"warn"`: Server continues startup but logs a prominent warning. The failed migration will be retried on next startup.

**Recovery procedure:**

1. Fix the underlying issue (bad config file, permission problem, etc.).
2. Restart the server. The runner sees the failed migration in history and retries it.
3. If the migration file itself was buggy and has been fixed: the checksum will differ. In lenient mode, the runner accepts this and retries. In strict mode, the administrator would need to manually update the checksum in the history file or delete the failed entry.

**Manual repair (escape hatch):**

If the history gets into an unrecoverable state, the administrator can:
- Delete `contents/.migration-history.json` entirely → all migrations re-run from V001 (which should be idempotent).
- Edit the history file manually to remove or fix entries.
- Run a repair command: `node server/migrations/runner.js --repair` (recalculates checksums, removes entries for missing files, marks failed as success).

### 3.11 Migration Helpers (utils.js)

Common configuration transformation patterns, provided as reusable functions:

```javascript
// Add a key with a default value if it doesn't exist
export function setDefault(obj, dotPath, defaultValue) { ... }

// Remove a key at a dot-separated path
export function removeKey(obj, dotPath) { ... }

// Rename a key (preserving its value)
export function renameKey(obj, oldDotPath, newDotPath) { ... }

// Deep merge defaults into existing config (existing values win)
export function mergeDefaults(existing, defaults) { ... }

// Add an item to an array if not already present (by id field)
export function addIfMissing(array, item, idField = 'id') { ... }

// Remove an item from an array by id
export function removeById(array, id, idField = 'id') { ... }

// Transform all items matching a predicate
export function transformWhere(array, predicate, transform) { ... }
```

---

## 4. Developer Workflow

### Adding a New Migration

When a developer makes a change that requires configuration updates for existing installations:

1. **Create the migration file** with the next available version number:
   ```bash
   # Check the latest version
   ls server/migrations/V*.js | tail -1
   # V017__add_workflow_features.js

   # Create the next one
   touch server/migrations/V018__add_mcp_tool_defaults.js
   ```

2. **Write the migration logic:**
   ```javascript
   export const version = '018';
   export const description = 'Add MCP tool defaults to tools.json';

   export async function precondition(ctx) {
     return ctx.fileExists('config/tools.json');
   }

   export async function up(ctx) {
     const tools = await ctx.readJson('config/tools.json');
     const defaults = await ctx.readDefaultJson('config/tools.json');

     // Find new tools in defaults that aren't in the user's config
     const existingIds = new Set((tools.tools || []).map(t => t.name));
     const newTools = (defaults.tools || []).filter(t => !existingIds.has(t.name));

     if (newTools.length > 0) {
       tools.tools = [...(tools.tools || []), ...newTools];
       await ctx.writeJson('config/tools.json', tools);
       ctx.log(`Added ${newTools.length} new tool(s): ${newTools.map(t => t.name).join(', ')}`);
     }
   }
   ```

3. **Also update `server/defaults/`** with the new default values (so fresh installations get them out of the box).

4. **Test** by running the server against an existing `contents/` directory. The migration should apply cleanly and the history should record it.

### Migration Naming Convention

```
V<version>__<description>.js

  V         → Versioned migration prefix
  <version> → Zero-padded 3-digit number (001, 002, ... 999)
  __        → Double underscore separator
  <description> → Snake_case description of the change
  .js       → ES module
```

Examples:
- `V001__baseline.js`
- `V002__migrate_providers_to_individual_files.js`
- `V003__add_anonymousAuth_structure.js`
- `V004__remove_legacy_allowAnonymous.js`
- `V005__add_cors_defaults.js`

---

## 5. Concrete Migration Examples

To illustrate the system's power, here are migrations that would address real changes in the codebase's history:

### Example 1: Replace `ensureDefaultProviders()`

This replaces the ad-hoc `providerMigration.js` with a proper versioned migration:

```javascript
// V002__ensure_default_providers.js
export const version = '002';
export const description = 'Ensure default providers are present';

export async function precondition(ctx) {
  return ctx.fileExists('config/providers.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/providers.json');
  const defaults = await ctx.readDefaultJson('config/providers.json');

  const existingIds = new Set(config.providers.map(p => p.id));
  const missing = defaults.providers.filter(p => !existingIds.has(p.id));

  if (missing.length > 0) {
    config.providers.push(...missing);
    await ctx.writeJson('config/providers.json', config);
    ctx.log(`Added ${missing.length} missing provider(s)`);
  }
}
```

After this migration is in place, `ensureDefaultProviders()` can be removed from `server.js`.

### Example 2: Rename a Configuration Key

```javascript
// V003__rename_allowAnonymous.js
export const version = '003';
export const description = 'Rename allowAnonymous to anonymousAuth structure';

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  if (platform.allowAnonymous !== undefined && platform.anonymousAuth === undefined) {
    platform.anonymousAuth = {
      enabled: platform.allowAnonymous === true,
      defaultGroups: ['anonymous']
    };
    delete platform.allowAnonymous;
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Migrated allowAnonymous → anonymousAuth');
  }
}
```

### Example 3: Add New Default Sections

```javascript
// V004__add_cors_defaults.js
export const version = '004';
export const description = 'Add default CORS configuration';

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  if (!platform.cors) {
    const defaults = await ctx.readDefaultJson('config/platform.json');
    platform.cors = defaults.cors;
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Added default CORS configuration');
  }
}
```

### Example 4: Migrate from Monolithic to Individual Files

```javascript
// V005__split_apps_to_individual_files.js
export const version = '005';
export const description = 'Split apps.json into individual app files';

export async function precondition(ctx) {
  // Only run if the legacy monolithic file exists
  return ctx.fileExists('config/apps.json');
}

export async function up(ctx) {
  const legacy = await ctx.readJson('config/apps.json');
  const apps = legacy.apps || [];

  for (const app of apps) {
    const targetPath = `apps/${app.id}.json`;
    if (!(await ctx.fileExists(targetPath))) {
      await ctx.writeJson(targetPath, app);
      ctx.log(`Extracted app: ${app.id}`);
    }
  }

  // Rename legacy file so it's not loaded again
  await ctx.moveFile('config/apps.json', 'config/apps.json.migrated');
  ctx.log(`Migrated ${apps.length} apps to individual files`);
}
```

---

## 6. Configuration

The migration runner itself is configured via `platform.json` (with sensible defaults so it works out of the box):

```json
{
  "migrations": {
    "enabled": true,
    "onFailure": "halt",
    "checksumValidation": "warn",
    "logLevel": "info"
  }
}
```

| Setting | Values | Default | Purpose |
|---------|--------|---------|---------|
| `enabled` | `true`, `false` | `true` | Master switch to disable all migrations |
| `onFailure` | `"halt"`, `"warn"` | `"halt"` | Behavior when a migration fails |
| `checksumValidation` | `"strict"`, `"warn"`, `"off"` | `"warn"` | How to handle modified migration files |
| `logLevel` | `"debug"`, `"info"`, `"warn"` | `"info"` | Verbosity of migration logging |

---

## 7. Edge Cases & Design Decisions

### Clustering

In clustered mode (multiple workers), only the primary process runs migrations. Workers wait for the primary to finish before initializing. This is already the pattern in `server.js` — migrations run in the `else` block of `cluster.isPrimary`.

### Concurrent Starts

If two server instances start simultaneously (e.g., blue-green deployment), both might try to run migrations. Mitigation: use a lock file (`contents/.migration-lock`). The runner creates it before starting and removes it after. If the lock file exists and is older than 5 minutes (stale lock), it's ignored.

### Docker / Read-Only Filesystems

If `contents/` is mounted read-only (unusual but possible), migrations cannot write. The runner detects this and logs a warning without failing the startup. The assumption is that read-only mounts are intentional and the operator has pre-applied migrations.

### Idempotency

All migrations should be written to be idempotent — safe to run multiple times. This is a best practice, not enforced by the runner. The history file prevents duplicate execution, but idempotency protects against edge cases (manual history deletion, recovery scenarios).

### Migration Ordering Guarantees

Migrations are always executed in strict version order. If V005 is pending but V004 was never applied (e.g., the file was added later), V004 runs first. There is no support for out-of-order execution.

### Backward Compatibility

The migration system is additive. It does not change any existing startup behavior. The `performInitialSetup()` step still copies missing default files. Migrations run after that step and transform what's already in `contents/`.

---

## 8. Implementation Plan

### Phase 1: Core Runner (MVP)

Build the migration runner with versioned migrations, history tracking, and the context API.

**Files to create:**
- `server/migrations/runner.js` — the migration engine
- `server/migrations/utils.js` — helper functions
- `server/migrations/V001__baseline.js` — baseline migration

**Files to modify:**
- `server/server.js` — insert `runConfigMigrations()` call after `performInitialSetup()`

**Acceptance criteria:**
- Fresh install: all migrations run, history file created.
- Existing install: baseline recorded, subsequent migrations applied.
- Failed migration: recorded with error, server halts or warns.
- Re-run: no migrations re-applied, server starts quickly.

### Phase 2: Replace Ad-Hoc Migrations

Convert `providerMigration.js` and any other one-off migration logic into versioned migrations.

**Files to create:**
- `V002__ensure_default_providers.js`

**Files to modify:**
- `server/server.js` — remove `ensureDefaultProviders()` call

### Phase 3: Preconditions & Repair

Add precondition support and a CLI repair command.

**Files to create or modify:**
- Update `runner.js` with precondition support
- Add `--repair` CLI mode to runner

### Phase 4: Ongoing

Every future configuration schema change ships with a corresponding migration file. The pattern becomes part of the standard development workflow, documented in `CLAUDE.md`.

---

## 9. Testing Strategy

### Unit Tests

- **Runner resolution logic:** Given a set of disk migrations and a history, assert the correct pending set.
- **Checksum validation:** Modify a migration file, assert validation warning/error.
- **Precondition handling:** Mock precondition returning false, assert migration skipped.
- **Context helpers:** Test `setDefault`, `removeKey`, `renameKey`, `mergeDefaults` with various inputs.

### Integration Tests

- **Fresh install end-to-end:** Start with empty contents, run all migrations, verify final config state.
- **Existing install end-to-end:** Start with populated contents and no history, verify baseline + pending migrations.
- **Failed migration recovery:** Introduce a failing migration, verify error recorded, fix it, restart, verify it completes.

### Manual Testing Checklist

- [ ] Fresh Docker deployment applies all migrations
- [ ] Existing Docker deployment with mounted `contents/` volume applies only new migrations
- [ ] Server starts correctly after all migrations
- [ ] `configCache.initialize()` loads migrated configuration correctly
- [ ] Failed migration produces a clear, actionable error message
- [ ] Migration history file is valid JSON after each run

---

## 10. Future Considerations

These are out of scope for the initial implementation but worth noting:

**Down migrations:** Flyway supports undo migrations (`U001__description.js`). For a configuration system, this would mean being able to roll back a config change. Initial implementation skips this — config backups before migration provide a simpler safety net.

**Admin UI integration:** The admin panel could display migration history, show pending migrations, and allow manual triggering. This would complement the automatic startup behavior.

**Dry-run mode:** A `--dry-run` flag that logs what migrations would be applied without actually running them. Useful for deployment verification.

**Backup before migrate:** Automatically create a timestamped backup of `contents/` before running migrations. Provides a simple rollback path without needing down migrations.

**Migration generation CLI:** A command like `node server/migrations/runner.js --create "add_new_feature"` that scaffolds a new migration file with the next version number.

---

## 11. Summary

This system brings the battle-tested patterns of Flyway to iHub Apps' JSON configuration. It replaces ad-hoc migration scripts with a versioned, auditable, and automated approach. The core principle is simple: every configuration schema change ships with a migration file, and the runner ensures every installation converges to the correct state, regardless of when it was first deployed or when it was last updated.

The MVP is small — a single `runner.js`, a `utils.js`, and a baseline migration. From there, every future config change follows the same pattern, and the days of "did the user's platform.json get the new CORS section?" are over.
