---
name: create-migration
description: Create a new versioned config migration in server/migrations/ following the project's Flyway-style pattern. Use when adding new required/default fields to config files, renaming/restructuring fields, or adding default entries to providers.json, groups.json, tools.json, sources.json, etc.
---

## Rules

- **Never modify** a migration file after it has been applied — checksums are tracked; mismatches halt startup.
- Migrations are **forward-only**. To undo a change, create a new higher-versioned migration.
- Do NOT create migrations for brand-new config files (handled by `performInitialSetup` copying from `server/defaults/`).
- Do NOT create migrations for code-only changes with no config schema impact.

## Steps

1. Find the next version number:
   ```bash
   ls server/migrations/V*.js | sort | tail -3
   ```

2. Create `server/migrations/V{NNN}__{short_description}.js` (NNN = zero-padded 3 digits, underscores in description):

```js
// server/migrations/V{NNN}__{short_description}.js
export const version = '{NNN}';
export const description = '{short_description}';

// Optional: return false to skip (e.g., if target file doesn't exist yet)
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');

  // setDefault NEVER overwrites values already set by the admin
  ctx.setDefault(config, 'features.myNewFlag', false);

  await ctx.writeJson('config/platform.json', config);
  ctx.log('Added features.myNewFlag default');
}
```

## ctx API Reference

| Method | Description |
|--------|-------------|
| `ctx.readJson(path)` | Read JSON from `contents/{path}` |
| `ctx.writeJson(path, data)` | Atomically write JSON to `contents/{path}` |
| `ctx.fileExists(path)` | Check if `contents/{path}` exists |
| `ctx.readDefaultJson(path)` | Read JSON from `server/defaults/{path}` |
| `ctx.listFiles(dir, pattern)` | List files in `contents/{dir}` |
| `ctx.deleteFile(path)` | Delete `contents/{path}` |
| `ctx.moveFile(from, to)` | Move file within `contents/` |
| `ctx.setDefault(obj, dotPath, value)` | Set value **only if path is missing** |
| `ctx.removeKey(obj, dotPath)` | Remove key at dot-path |
| `ctx.renameKey(obj, oldPath, newPath)` | Move key from old to new path |
| `ctx.mergeDefaults(existing, defaults)` | Deep merge; existing values always win |
| `ctx.addIfMissing(array, item, idField)` | Push item if no match on `idField` |
| `ctx.removeById(array, id, idField)` | Remove first item matching `id` |
| `ctx.transformWhere(array, pred, fn)` | Apply `fn` to items matching `pred` |
| `ctx.log(msg)` / `ctx.warn(msg)` | Structured logging with version prefix |

## Verify

After creating the migration, verify it runs cleanly:
```bash
timeout 10s node server/server.js 2>&1 | grep -E "migration|V{NNN}|error" | head -20
```

Migration history is stored at `contents/.migration-history.json`.
