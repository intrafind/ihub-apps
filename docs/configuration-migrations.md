# Configuration Migrations

iHub Apps uses a versioned migration system (similar to Flyway) to evolve configuration files across releases. Migrations run automatically on server startup before `configCache` initializes.

## When to Write a Migration

Create a migration whenever you:

- Add new required or default fields to existing config files (e.g., a new section in `platform.json`)
- Rename or restructure fields in JSON config files
- Add default entries to `providers.json`, `groups.json`, `tools.json`, etc.
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

## Rules

- **Never modify an applied migration** — checksums are tracked; mismatches trigger warnings or halt startup.
- Migrations are **forward-only**. To undo a change, create a new higher-versioned migration.
- History is stored at `contents/.migration-history.json`. Each entry records status, checksum, and timing.
- V001 is the no-op baseline; new migrations start at the next available number.
- **Version collisions are caught in CI.** Two branches opened from the same `main` both pick "highest + 1". The `Migration Version Check` workflow compares each PR's new migrations against the _current_ base branch and fails on a reused version, a version below the base's highest one, or an `export const version` that differs from the file name. When migrations land on `main`/`develop`, it re-runs the check on every open PR that adds migrations, so the second PR turns red as soon as the first merges. Fix by merging the base branch and renumbering to the next free version the check reports. Run it locally with `node scripts/check-migration-versions.js --base origin/main`.
