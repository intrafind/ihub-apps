# Configuration Migrations

iHub Apps uses a versioned migration system (similar to Flyway) to evolve configuration files across releases. Migrations run automatically on server startup before `configCache` initializes.

## When to Write a Migration

Create a migration whenever you:

- Add new required or default fields to existing config files (e.g., a new section in `platform.json`)
- Rename or restructure fields in JSON config files
- Add default entries to `providers.json`, `groups.json`, `integrations.json`, etc.
- Remove or move configuration keys that existing installations may still have in the old format

**Do NOT** create migrations for:

- Adding brand-new config files (handled by `performInitialSetup` copying from `server/defaults/`)
- Client-side changes or code-only changes with no config schema impact
- A change to what the installations of one integration definition store (an install field renamed, an action renamed or removed, a value that needs a default): the definition ships a **definition migration** for that, run per installation with a backup when the definition changes (an iHub release that updates a built-in definition, a marketplace update). See [Integrations → Migrations](integrations.md#migrations).

### What stays numbered

Numbered migrations stay for everything that is not an installation's own data: `platform.json`, apps, groups, models, providers, and also changes that span integrations, such as creating installations from an older config file, moving a setting from `platform.json` into an installation, or grants on the groups. When a release changes both, the numbered migration runs first (at startup, before anything loads), the definition migrations of the built-in definitions right after it, still before the workers start.

## How to Create a Migration

1. Find the next available version by checking `server/migrations/V*.js`.
2. Create `server/migrations/V{NNN}__{short_description}.js` (zero-padded to 3 digits, underscores in description):

```javascript
// server/migrations/V003__add_feature_flag.js
export const version = '003';
export const description = 'add_feature_flag';

// Optional: return false to skip (e.g., if the target file doesn't exist)
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // setDefault never overwrites values already set by the admin
  ctx.setDefault(platform, 'features.myNewFlag', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added features.myNewFlag default');
}
```

## Migration Context API (`ctx`)

| Method | Description |
| --- | --- |
| `ctx.readJson(path)` | Read JSON from `contents/{path}` |
| `ctx.writeJson(path, data)` | Atomically write JSON to `contents/{path}` |
| `ctx.fileExists(path)` | Check if `contents/{path}` exists |
| `ctx.readDefaultJson(path)` | Read JSON from `server/defaults/{path}` |
| `ctx.listFiles(dir, pattern)` | List files in `contents/{dir}` |
| `ctx.deleteFile(path)` | Delete `contents/{path}` |
| `ctx.moveFile(from, to)` | Move file within `contents/` |
| `ctx.setDefault(obj, dotPath, value)` | Set value only if path is missing |
| `ctx.removeKey(obj, dotPath)` | Remove key at dot-path |
| `ctx.renameKey(obj, oldPath, newPath)` | Move key from old to new path |
| `ctx.mergeDefaults(existing, defaults)` | Deep merge; existing values always win |
| `ctx.addIfMissing(array, item, idField)` | Push item if no match on `idField` |
| `ctx.removeById(array, id, idField)` | Remove first item matching `id` |
| `ctx.transformWhere(array, pred, fn)` | Apply `fn` to items matching `pred` |
| `ctx.log(msg)` / `ctx.warn(msg)` | Structured logging with version prefix |

## Baseline (squashed migrations)

Migrations up to the **baseline** have been deleted from the repository: the baseline is **V030**, the last migration of release **5.3.0**. `V031` and everything above stays, numbered as it was shipped. The runner (`server/migrations/runner.js`, `BASELINE_VERSION` / `BASELINE_RELEASE`) treats the baseline like this:

- **Fresh install** (`contents/` seeded from `server/defaults` by this start): recorded as applied at V030 (a `baseline` row in the history); the migrations above V030 then run against the defaults like on any other install.
- **Existing install at or above V030** (highest `success` or `skipped` row in the history): starts normally. History rows of removed versions, with their old checksums, are only history: they are never checksum-validated and never reported as "no longer on disk", even with `checksumValidation: strict`. A gap in numbers below the baseline is fine for `scripts/check-migration-versions.js`.
- **Existing install below V030**, or a `contents/` with a configuration but no migration history (it predates the migration system): the server logs an error and exits with code 1. The message tells the admin to upgrade to release 5.3.x first, start it once, and then upgrade to the current release. Nothing is migrated or written.

Supported upgrade path: from release 5.3.0 or newer straight to the latest release.

### Raising the baseline later

1. Pick the release R that is old enough that no supported install is below it. Its highest migration is the last `V*` file in `server/migrations/` at the tag of R (list it with `ls-tree --name-only vR:server/migrations` of the repository); that number is the new baseline.
2. Change `BASELINE_VERSION` and `BASELINE_RELEASE` in `server/migrations/runner.js`.
3. Delete the migration files up to the baseline and their `server/tests/migration-v<NNN>.test.js` files. Keep files that something else imports. `server/migrations/support/legacyRuntimeImport.js` stays: V219 imports it.
4. Keep the `RENAMED_MIGRATIONS` rows whose new version is above the baseline (they stop an install that ran a branch from re-applying the renumbered migration). Drop the rows whose new version is at or below it.
5. Check that migrations above the baseline do not read a `server/defaults` file that only a removed migration used to create, update the text above, and add a release note for the new minimum release.

## Rules

- **Never modify an applied migration** — checksums are tracked; mismatches trigger warnings or halt startup.
- Migrations are **forward-only**. To undo a change, create a new higher-versioned migration.
- History is stored at `contents/.migration-history.json`. Each entry records status, checksum, and timing.
- New migrations start at the next available number above the highest one in `server/migrations/`. The numbers up to the baseline (below) are gone from the repository and are never reused.
- **Version collisions are caught in CI.** Two branches opened from the same `main` both pick "highest + 1". The `Migration Version Check` workflow compares each PR's new migrations against the _current_ base branch and fails on a reused version, a version below the base's highest one, or an `export const version` that differs from the file name. When migrations land on `main`/`develop`, it re-runs the check on every open PR that adds migrations, so the second PR turns red as soon as the first merges. Fix by merging the base branch and renumbering to the next free version the check reports. Run it locally with `node scripts/check-migration-versions.js --base origin/main`.
